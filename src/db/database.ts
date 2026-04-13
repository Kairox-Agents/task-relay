import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { migration001 } from './migrations/001_initial.js';

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
  down: (db: Database.Database) => void;
}

const MIGRATIONS: Migration[] = [migration001];

export class DatabaseManager {
  private db: Database.Database;
  private dbPath: string;

  constructor(dbPath?: string) {
    const configDir = dbPath || join(homedir(), '.task-relay');
    mkdirSync(configDir, { recursive: true });

    this.dbPath = join(configDir, 'tasks.db');
    this.db = new Database(this.dbPath);

    // Enable WAL mode for better concurrency
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');

    this.runMigrations();
  }

  private runMigrations(): void {
    // Create migrations table if not exists
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    // Get applied migrations
    const applied = this.db
      .prepare('SELECT version FROM migrations ORDER BY version')
      .all()
      .map((row: any) => row.version as number);

    // Run pending migrations
    for (const migration of MIGRATIONS) {
      if (!applied.includes(migration.version)) {
        console.log(`Running migration: ${migration.name}`);
        this.db.transaction(() => {
          migration.up(this.db);
          this.db.prepare(
            'INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)'
          ).run(migration.version, migration.name, new Date().toISOString());
        })();
        console.log(`Migration ${migration.name} completed`);
      }
    }
  }

  getDatabase(): Database.Database {
    return this.db;
  }

  close(): void {
    // Finalize WAL checkpoint for clean shutdown
    this.db.pragma('wal_checkpoint(RESTART)');
    this.db.close();
  }
}
