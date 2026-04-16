/**
 * Backup Manager — handles log backups, full snapshots, and agent trace uploads.
 *
 * Three categories:
 * 1. Log backup (incremental) — task events since last backup → NDJSON → S3
 * 2. Full backup (periodic) — SQLite snapshot + config → tar.gz → S3
 * 3. Agent traces (per-task) — Claude session transcripts → S3
 */

import { BackupClient } from './s3-client.js';
import type { BackupConfig } from '../config/schema.js';
import type { TaskRepository } from '../db/tasks.js';
import type { DatabaseManager } from '../db/database.js';
import { readFile, writeFile, mkdir, stat, copyFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createReadStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

export interface BackupState {
  lastLogBackup: string | null; // ISO timestamp
  lastFullBackup: string | null;
  pendingTraces: string[]; // Task IDs with pending trace uploads
}

const STATE_FILE = 'backup-state.json';

export class BackupManager {
  private client: BackupClient;
  private config: BackupConfig;
  private taskRepo: TaskRepository | null = null;
  private dbManager: DatabaseManager | null = null;
  private stateDir: string;
  private state: BackupState = { lastLogBackup: null, lastFullBackup: null, pendingTraces: [] };
  private logTimer: ReturnType<typeof setInterval> | null = null;
  private fullTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: BackupConfig, stateDir: string) {
    this.config = config;
    this.stateDir = stateDir;

    const accessKeyId = process.env.AWS_ACCESS_KEY_ID || '';
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || '';

    this.client = new BackupClient({
      endpoint: config.endpoint,
      region: config.region,
      bucket: config.bucket,
      credentials: accessKeyId ? { accessKeyId, secretAccessKey } : undefined,
    });
  }

  setRepositories(taskRepo: TaskRepository, dbManager: DatabaseManager) {
    this.taskRepo = taskRepo;
    this.dbManager = dbManager;
  }

  async init(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await this.loadState();
  }

  async start(): Promise<void> {
    if (!this.config.enabled) return;

    // Check connectivity
    const ok = await this.client.ping();
    if (!ok) {
      console.warn('Backup: S3 bucket not reachable — backups will be retried');
    }

    // Log backup interval
    this.logTimer = setInterval(
      () => this.backupLogs().catch((err) => console.error('Log backup failed:', err)),
      this.config.log_interval_ms
    );

    // Full backup interval (convert hours to ms)
    this.fullTimer = setInterval(
      () => this.backupFull().catch((err) => console.error('Full backup failed:', err)),
      this.config.full_interval_hours * 3600 * 1000
    );
  }

  async stop(): Promise<void> {
    if (this.logTimer) clearInterval(this.logTimer);
    if (this.fullTimer) clearInterval(this.fullTimer);
    this.logTimer = null;
    this.fullTimer = null;

    // Flush pending work
    if (this.config.enabled) {
      await this.backupLogs().catch(() => {});
      await this.flushPendingTraces().catch(() => {});
    }
  }

  // ---- Log Backup (Incremental) ----

  async backupLogs(): Promise<{ uploaded: number }> {
    if (!this.taskRepo) return { uploaded: 0 };

    const since = this.state.lastLogBackup || new Date(0).toISOString();
    const tasks = this.taskRepo.listSince(since, 1000);

    if (tasks.length === 0) return { uploaded: 0 };

    const ndjson = tasks.map((t) => JSON.stringify(t)).join('\n');
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const ts = now.toISOString().replace(/[:.]/g, '-');
    const key = `logs/${date}/${ts}.ndjson`;

    await this.client.upload(key, ndjson, 'application/x-ndjson');

    this.state.lastLogBackup = now.toISOString();
    await this.saveState();

    return { uploaded: tasks.length };
  }

  // ---- Full Backup ----

  async backupFull(): Promise<{ key: string; size: number }> {
    if (!this.dbManager) throw new Error('DB not set');

    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const key = `backups/${date}.tar.gz`;
    const tmpPath = join(this.stateDir, `backup-${date}.tar.gz`);

    // SQLite checkpoint for consistent snapshot
    this.dbManager.getDatabase().pragma('wal_checkpoint(TRUNCATE)');

    // Copy the DB file
    const dbPath = (this.dbManager as any).dbPath as string;
    if (!dbPath) throw new Error('Cannot determine DB path');

    // Simple gzip of the DB file (not a full tar — keep it minimal for v1)
    const dbData = await readFile(dbPath);
    const { createGzip } = await import('node:zlib');
    const gz = createGzip();

    await new Promise<void>((resolve, reject) => {
      gz.on('data', (chunk) => {
        // Collect gzipped data
      });
      gz.on('end', resolve);
      gz.on('error', reject);
      gz.write(dbData);
      gz.end();
    });

    // Actually write it properly
    const { gzipSync } = await import('node:zlib');
    const compressed = gzipSync(dbData);
    await writeFile(tmpPath, compressed);

    await this.client.upload(key, compressed, 'application/gzip');

    // Cleanup temp file
    await unlink(tmpPath).catch(() => {});

    this.state.lastFullBackup = now.toISOString();
    await this.saveState();

    // Enforce retention
    await this.enforceBackupRetention();

    return { key, size: compressed.length };
  }

  private async enforceBackupRetention(): Promise<void> {
    const objects = await this.client.list('backups/');
    const retentionDays = this.config.retention_days;

    const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000);
    const toDelete = objects.filter(
      (o) => o.lastModified && o.lastModified < cutoff
    );

    if (toDelete.length > 0) {
      await this.client.delete(toDelete.map((o) => o.key));
    }
  }

  // ---- Agent Trace Backup ----

  async backupTrace(taskId: string, workingDir: string): Promise<void> {
    if (!this.config.enabled) return;

    const traces: { key: string; path: string }[] = [];

    // Claude Code session transcript
    const cwdDashed = workingDir.replace(/\//g, '-');
    const claudeBase = join(homedir(), '.claude', 'projects', cwdDashed);
    const sessionFile = join(claudeBase, `${taskId}.jsonl`);
    const debugFile = join(homedir(), '.claude', 'debug', `${taskId}.txt`);

    if (existsSync(sessionFile)) {
      traces.push({ key: `traces/${taskId}/claude-session.jsonl`, path: sessionFile });
    }
    if (existsSync(debugFile)) {
      traces.push({ key: `traces/${taskId}/claude-debug.txt`, path: debugFile });
    }

    if (traces.length === 0) {
      // Queue for later retry
      if (!this.state.pendingTraces.includes(taskId)) {
        this.state.pendingTraces.push(taskId);
        await this.saveState();
      }
      return;
    }

    for (const trace of traces) {
      try {
        const data = await readFile(trace.path);
        await this.client.upload(trace.key, data, 'application/x-ndjson');
      } catch (err) {
        console.warn(`Trace upload failed for ${taskId}:`, err);
        if (!this.state.pendingTraces.includes(taskId)) {
          this.state.pendingTraces.push(taskId);
          await this.saveState();
        }
      }
    }
  }

  private async flushPendingTraces(): Promise<void> {
    if (!this.taskRepo || this.state.pendingTraces.length === 0) return;

    const remaining: string[] = [];
    for (const taskId of this.state.pendingTraces) {
      const task = this.taskRepo.get(taskId);
      if (task?.working_dir) {
        try {
          await this.backupTrace(taskId, task.working_dir);
          // Check if it succeeded by seeing if it's still pending
          const cwdDashed = task.working_dir.replace(/\//g, '-');
          const sessionFile = join(homedir(), '.claude', 'projects', cwdDashed, `${taskId}.jsonl`);
          if (existsSync(sessionFile)) {
            remaining.push(taskId); // Still exists = upload failed
          }
        } catch {
          remaining.push(taskId);
        }
      }
    }

    if (remaining.length !== this.state.pendingTraces.length) {
      this.state.pendingTraces = remaining;
      await this.saveState();
    }
  }

  // ---- State ----

  private async loadState(): Promise<void> {
    const statePath = join(this.stateDir, STATE_FILE);
    if (existsSync(statePath)) {
      try {
        const raw = await readFile(statePath, 'utf-8');
        this.state = JSON.parse(raw);
      } catch {
        this.state = { lastLogBackup: null, lastFullBackup: null, pendingTraces: [] };
      }
    }
  }

  private async saveState(): Promise<void> {
    const statePath = join(this.stateDir, STATE_FILE);
    await writeFile(statePath, JSON.stringify(this.state, null, 2));
  }
}
