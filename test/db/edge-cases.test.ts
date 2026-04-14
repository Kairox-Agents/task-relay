import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseManager } from '../../src/db/database.js';
import { TaskRepository } from '../../src/db/tasks.js';
import { v4 as uuidv4 } from 'uuid';
import type { Task } from '../../src/config/schema.js';

describe('Database Edge Cases', () => {
  let dbManager: DatabaseManager;
  let taskRepo: TaskRepository;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), 'task-relay-db-edge-' + Date.now());
    dbManager = new DatabaseManager(testDir);
    taskRepo = new TaskRepository(dbManager.getDatabase());
  });

  afterEach(async () => {
    dbManager.close();
    await rm(testDir, { recursive: true, force: true });
  });

  const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: uuidv4(), type: 'shell', prompt: 'echo test', working_dir: '/tmp',
    isolation: 'host', timeout_ms: 5000, env: {}, allow_network: false,
    model: 'sonnet', max_budget_usd: 1.0, acceptance_criteria: null,
    max_iterations: 1, judge_model: null, current_iteration: 1,
    judge_history: [], judge_result: null, status: 'pending',
    created_at: new Date().toISOString(), started_at: null, completed_at: null,
    exit_code: null, error: null, output_path: null, cost_usd: 0,
    ...overrides,
  });

  // DB-01: Migration idempotency
  it('should handle running DatabaseManager twice without error', () => {
    // Second manager on same DB
    const db2 = new DatabaseManager(testDir);
    const repo2 = new TaskRepository(db2.getDatabase());

    // Create and read
    const task = makeTask();
    repo2.create(task);
    const found = repo2.getById(task.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(task.id);

    db2.close();
  });

  // DB-05: Empty JSON fields
  it('should round-trip empty env and judge_history', () => {
    const task = makeTask({ env: {}, judge_history: [] });
    taskRepo.create(task);

    const found = taskRepo.getById(task.id)!;
    expect(found.env).toEqual({});
    expect(found.judge_history).toEqual([]);
  });

  // DB-06: Null handling
  it('should round-trip nullable fields as null not undefined', () => {
    const task = makeTask();
    taskRepo.create(task);

    const found = taskRepo.getById(task.id)!;
    expect(found.started_at).toBeNull();
    expect(found.completed_at).toBeNull();
    expect(found.exit_code).toBeNull();
    expect(found.error).toBeNull();
    expect(found.output_path).toBeNull();
    expect(found.judge_result).toBeNull();
  });

  // DB-07: Large JSON in env
  it('should handle large env object', () => {
    const env: Record<string, string> = {};
    for (let i = 0; i < 1000; i++) {
      env[`TASK_VAR_${i}`] = `value_${i}`;
    }
    const task = makeTask({ env });
    taskRepo.create(task);

    const found = taskRepo.getById(task.id)!;
    expect(Object.keys(found.env)).toHaveLength(1000);
    expect(found.env.TASK_VAR_999).toBe('value_999');
  });

  // DB-08: List ordering (newest first)
  it('should list tasks newest first', async () => {
    const t1 = makeTask({ created_at: new Date(Date.now() - 3000).toISOString() });
    const t2 = makeTask({ created_at: new Date(Date.now() - 2000).toISOString() });
    const t3 = makeTask({ created_at: new Date(Date.now() - 1000).toISOString() });

    taskRepo.create(t1);
    taskRepo.create(t2);
    taskRepo.create(t3);

    const list = taskRepo.list();
    expect(list[0].id).toBe(t3.id);
    expect(list[1].id).toBe(t2.id);
    expect(list[2].id).toBe(t1.id);
  });

  // DB-09: Count accuracy after concurrent create/delete
  it('should maintain accurate count after create and delete', () => {
    const tasks = [];
    for (let i = 0; i < 10; i++) {
      const t = makeTask();
      taskRepo.create(t);
      tasks.push(t);
    }
    expect(taskRepo.countByStatus('pending')).toBe(10);

    // Delete 3
    taskRepo.delete(tasks[0].id);
    taskRepo.delete(tasks[1].id);
    taskRepo.delete(tasks[2].id);
    expect(taskRepo.countByStatus('pending')).toBe(7);
  });

  // DB-11: getNextPending returns FIFO (oldest first)
  it('should return oldest pending task first', () => {
    const t1 = makeTask({ created_at: new Date(Date.now() - 3000).toISOString() });
    const t2 = makeTask({ created_at: new Date(Date.now() - 2000).toISOString() });
    const t3 = makeTask({ created_at: new Date(Date.now() - 1000).toISOString() });

    taskRepo.create(t3);
    taskRepo.create(t1);
    taskRepo.create(t2);

    const next = taskRepo.getNextPending();
    expect(next).not.toBeNull();
    expect(next!.id).toBe(t1.id);
  });

  // DB-12: getNextPending skips non-pending tasks
  it('should skip running and completed tasks in getNextPending', () => {
    const t1 = makeTask({ status: 'running' });
    const t2 = makeTask({ status: 'completed' });
    const t3 = makeTask({ status: 'pending' });

    taskRepo.create(t1);
    taskRepo.create(t2);
    taskRepo.create(t3);

    const next = taskRepo.getNextPending();
    expect(next).not.toBeNull();
    expect(next!.id).toBe(t3.id);
  });

  // DB-13: updateResult with all null fields
  it('should handle updateResult with null fields', () => {
    const task = makeTask();
    taskRepo.create(task);

    taskRepo.updateResult(task.id, {
      exit_code: null,
      error: null,
      output_path: null,
      cost_usd: 0,
    });

    const found = taskRepo.getById(task.id)!;
    expect(found.exit_code).toBeNull();
    expect(found.error).toBeNull();
    expect(found.cost_usd).toBe(0);
  });

  // DB-14: updateJudgeState with empty history
  it('should handle updateJudgeState with empty history', () => {
    const task = makeTask();
    taskRepo.create(task);

    taskRepo.updateJudgeState(task.id, 2, [], null);

    const found = taskRepo.getById(task.id)!;
    expect(found.current_iteration).toBe(2);
    expect(found.judge_history).toEqual([]);
    expect(found.judge_result).toBeNull();
  });

  // DB-15: Operations after close should fail
  it('should throw after DatabaseManager.close()', () => {
    const dbCopy = new DatabaseManager(join(testDir, 'closed.db'));
    const repoCopy = new TaskRepository(dbCopy.getDatabase());
    const t = makeTask();
    repoCopy.create(t);
    dbCopy.close();
    expect(() => repoCopy.list()).toThrow();
  });

  // DB-17: Special characters in prompt
  it('should handle special characters in prompt', () => {
    const prompts = [
      'echo "hello 世界 🌍"',
      'echo "quotes: \'single\' and \"double\""',
      'echo "newlines:\nand\ttabs"',
      'echo "dollar: $HOME and backtick: `date`"',
    ];
    for (const prompt of prompts) {
      const task = makeTask({ prompt });
      taskRepo.create(task);
      const found = taskRepo.getById(task.id)!;
      expect(found.prompt).toBe(prompt);
    }
  });

  // DB-18: Very long prompt
  it('should handle 100KB prompt', () => {
    const longPrompt = 'x'.repeat(100_000);
    const task = makeTask({ prompt: longPrompt });
    taskRepo.create(task);
    const found = taskRepo.getById(task.id)!;
    expect(found.prompt).toBe(longPrompt);
  });

  // DB-19: Cost precision
  it('should handle cost_usd with high precision', () => {
    const task = makeTask({ cost_usd: 0.001234567 });
    taskRepo.create(task);
    const found = taskRepo.getById(task.id)!;
    expect(found.cost_usd).toBeCloseTo(0.001234567, 6);
  });

  // DB-10: Archive with exact boundary
  it('should handle archive at max_tasks boundary', () => {
    // Create 10 tasks
    for (let i = 0; i < 10; i++) {
      taskRepo.create(makeTask());
    }
    expect(taskRepo.countByStatus('pending')).toBe(10);

    // Archive keeping only 5
    const archived = taskRepo.archiveOldTasks(30, 5);
    expect(archived).toBe(5);
    expect(taskRepo.countByStatus('pending')).toBe(5);
  });

  // DB-04: Schema enforcement — empty prompt should still work (zod catches it before DB)
  it('should store and retrieve task with all fields populated', () => {
    const task = makeTask({
      status: 'completed',
      started_at: '2026-04-14T00:00:00.000Z',
      completed_at: '2026-04-14T00:00:01.000Z',
      exit_code: 0,
      error: null,
      output_path: '/tmp/output.log',
      cost_usd: 0.05,
      env: { TASK_FOO: 'bar', TASK_BAZ: 'qux' },
      acceptance_criteria: 'Must pass all tests',
      judge_model: 'haiku',
      judge_history: [{ iteration: 1, score: 80, feedback: 'Good' }],
      judge_result: { final_score: 95, status: 'pass' },
    });
    taskRepo.create(task);
    const found = taskRepo.getById(task.id)!;
    expect(found.status).toBe('completed');
    expect(found.started_at).toBe('2026-04-14T00:00:00.000Z');
    expect(found.cost_usd).toBe(0.05);
    expect(found.env).toEqual({ TASK_FOO: 'bar', TASK_BAZ: 'qux' });
    expect(found.judge_history).toEqual([{ iteration: 1, score: 80, feedback: 'Good' }]);
    expect(found.judge_result).toEqual({ final_score: 95, status: 'pass' });
  });
});
