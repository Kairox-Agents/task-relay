import type { Migration } from '../database.js';

export const migration001: Migration = {
  version: 1,
  name: 'initial',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        prompt TEXT NOT NULL,
        working_dir TEXT NOT NULL,
        isolation TEXT NOT NULL,
        timeout_ms INTEGER NOT NULL,
        env TEXT,
        allow_network INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL,
        max_budget_usd REAL NOT NULL,
        acceptance_criteria TEXT,
        max_iterations INTEGER NOT NULL,
        judge_model TEXT,
        current_iteration INTEGER NOT NULL DEFAULT 1,
        judge_history TEXT,
        judge_result TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        exit_code INTEGER,
        error TEXT,
        output_path TEXT,
        cost_usd REAL NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
    `);
  },
  down: (db) => {
    db.exec(`DROP TABLE IF EXISTS tasks`);
  },
};
