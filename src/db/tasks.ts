import type { Database } from 'better-sqlite3';
import type { Task, TaskStatus } from '../config/schema.js';

export class TaskRepository {
  constructor(private db: Database) {}

  /**
   * Create a new task.
   */
  create(task: Task): Task {
    const stmt = this.db.prepare(`
      INSERT INTO tasks (
        id, type, prompt, working_dir, isolation, timeout_ms, env, allow_network,
        model, max_budget_usd, acceptance_criteria, max_iterations, judge_model,
        current_iteration, judge_history, judge_result, status, created_at,
        started_at, completed_at, exit_code, error, output_path, cost_usd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      task.id,
      task.type,
      task.prompt,
      task.working_dir,
      task.isolation,
      task.timeout_ms,
      JSON.stringify(task.env || {}),
      task.allow_network ? 1 : 0,
      task.model,
      task.max_budget_usd,
      task.acceptance_criteria,
      task.max_iterations,
      task.judge_model,
      task.current_iteration,
      JSON.stringify(task.judge_history),
      JSON.stringify(task.judge_result),
      task.status,
      task.created_at,
      task.started_at,
      task.completed_at,
      task.exit_code,
      task.error,
      task.output_path,
      task.cost_usd
    );

    return task;
  }

  /**
   * Get a task by ID.
   */
  getById(id: string): Task | null {
    const stmt = this.db.prepare('SELECT * FROM tasks WHERE id = ?');
    const row = stmt.get(id) as any;
    return row ? this.mapRowToTask(row) : null;
  }

  /**
   * Update task status.
   */
  updateStatus(id: string, status: TaskStatus): void {
    const stmt = this.db.prepare('UPDATE tasks SET status = ? WHERE id = ?');
    stmt.run(status, id);
  }

  /**
   * Update task started time.
   */
  updateStartedAt(id: string, startedAt: string): void {
    const stmt = this.db.prepare('UPDATE tasks SET started_at = ? WHERE id = ?');
    stmt.run(startedAt, id);
  }

  /**
   * Update task completed time.
   */
  updateCompletedAt(id: string, completedAt: string): void {
    const stmt = this.db.prepare('UPDATE tasks SET completed_at = ? WHERE id = ?');
    stmt.run(completedAt, id);
  }

  /**
   * Update task result (exit code, error, output path, cost).
   */
  updateResult(
    id: string,
    result: {
      exit_code: number | null;
      error: string | null;
      output_path: string | null;
      cost_usd: number;
    }
  ): void {
    const stmt = this.db.prepare(`
      UPDATE tasks
      SET exit_code = ?, error = ?, output_path = ?, cost_usd = ?
      WHERE id = ?
    `);
    stmt.run(result.exit_code, result.error, result.output_path, result.cost_usd, id);
  }

  /**
   * Update judge loop state.
   */
  updateJudgeState(id: string, currentIteration: number, judgeHistory: unknown[], judgeResult: unknown): void {
    const stmt = this.db.prepare(`
      UPDATE tasks
      SET current_iteration = ?, judge_history = ?, judge_result = ?
      WHERE id = ?
    `);
    stmt.run(
      currentIteration,
      JSON.stringify(judgeHistory),
      JSON.stringify(judgeResult),
      id
    );
  }

  /**
   * List tasks with optional status filter.
   */
  list(status?: TaskStatus, limit = 100, offset = 0): Task[] {
    let sql = 'SELECT * FROM tasks';
    const params: any[] = [];

    if (status) {
      sql += ' WHERE status = ?';
      params.push(status);
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];
    return rows.map((row) => this.mapRowToTask(row));
  }

  /**
   * Delete a task.
   */
  delete(id: string): void {
    const stmt = this.db.prepare('DELETE FROM tasks WHERE id = ?');
    stmt.run(id);
  }

  /**
   * Archive old tasks (soft delete).
   */
  archiveOldTasks(maxAgeDays: number, maxTasks: number): number {
    const now = new Date();
    const cutoffDate = new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();

    // Archive by age
    const ageStmt = this.db.prepare(`
      UPDATE tasks
      SET status = 'archived'
      WHERE status != 'archived'
      AND created_at < ?
      AND status != 'failed'
    `);
    const ageResult = ageStmt.run(cutoffDate);

    // Archive by count (keep only max_tasks)
    const countStmt = this.db.prepare(`
      UPDATE tasks
      SET status = 'archived'
      WHERE id IN (
        SELECT id FROM tasks
        WHERE status != 'archived'
        ORDER BY created_at DESC
        LIMIT -1 OFFSET ?
      )
      AND status != 'failed'
    `);
    const countResult = countStmt.run(maxTasks);

    return ageResult.changes + countResult.changes;
  }

  /**
   * Get next pending task.
   */
  getNextPending(): Task | null {
    const stmt = this.db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 1
    `);
    const row = stmt.get() as any;
    return row ? this.mapRowToTask(row) : null;
  }

  /**
   * Count tasks by status.
   */
  countByStatus(status: TaskStatus): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM tasks WHERE status = ?');
    const result = stmt.get(status) as any;
    return result.count;
  }

  private mapRowToTask(row: any): Task {
    return {
      id: row.id,
      type: row.type,
      prompt: row.prompt,
      working_dir: row.working_dir,
      isolation: row.isolation,
      timeout_ms: row.timeout_ms,
      env: JSON.parse(row.env || '{}'),
      allow_network: row.allow_network === 1,
      model: row.model,
      max_budget_usd: row.max_budget_usd,
      acceptance_criteria: row.acceptance_criteria,
      max_iterations: row.max_iterations,
      judge_model: row.judge_model,
      current_iteration: row.current_iteration,
      judge_history: JSON.parse(row.judge_history || '[]'),
      judge_result: JSON.parse(row.judge_result || 'null'),
      status: row.status,
      created_at: row.created_at,
      started_at: row.started_at,
      completed_at: row.completed_at,
      exit_code: row.exit_code,
      error: row.error,
      output_path: row.output_path,
      cost_usd: row.cost_usd,
    };
  }
}
