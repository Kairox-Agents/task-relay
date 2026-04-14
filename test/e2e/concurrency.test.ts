import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseManager, TaskRepository } from '../../src/db/index.js';
import { TaskQueue } from '../../src/executor/queue.js';
import { TaskDaemon } from '../../src/executor/daemon.js';
import { ShellExecutor } from '../../src/executor/shell.js';
import { registry } from '../../src/executor/registry.js';
import { v4 as uuidv4 } from 'uuid';
import type { Task } from '../../src/config/schema.js';

describe('Concurrency', () => {
  let dbManager: DatabaseManager;
  let taskRepo: TaskRepository;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), 'task-relay-conc-' + Date.now());
    await mkdir(testDir, { recursive: true });
    dbManager = new DatabaseManager(join(testDir, 'conc.db'));
    taskRepo = new TaskRepository(dbManager.getDatabase());
    registry.register(new ShellExecutor());
  });

  afterEach(async () => {
    dbManager.close();
    await rm(testDir, { recursive: true, force: true });
  });

  const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: uuidv4(), type: 'shell', prompt: 'echo test', working_dir: testDir,
    isolation: 'host', timeout_ms: 10000, env: {}, allow_network: false,
    model: 'sonnet', max_budget_usd: 1.0, acceptance_criteria: null,
    max_iterations: 1, judge_model: null, current_iteration: 1,
    judge_history: [], judge_result: null, status: 'pending',
    created_at: new Date().toISOString(), started_at: null, completed_at: null,
    exit_code: null, error: null, output_path: null, cost_usd: 0,
    ...overrides,
  });

  const waitForStatus = async (id: string, status: string, maxMs = 10000): Promise<Task | null> => {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const task = taskRepo.getById(id);
      if (task?.status === status) return task;
      await new Promise(r => setTimeout(r, 50));
    }
    return taskRepo.getById(id);
  };

  // CON-01: Two tasks submitted simultaneously, only one runs at a time
  it('should execute only one task at a time with maxConcurrent=1', async () => {
    const queue = new TaskQueue({ maxConcurrent: 1, maxQueueSize: 100 });
    const daemon = new TaskDaemon({ taskQueue: queue, taskRepo });

    const t1 = makeTask({ prompt: 'echo "task1"; sleep 0.5; echo "task1-done"' });
    const t2 = makeTask({ prompt: 'echo "task2"; sleep 0.5; echo "task2-done"' });

    taskRepo.create(t1);
    taskRepo.create(t2);

    // Add both simultaneously
    queue.add(t1);
    queue.add(t2);

    // t1 should be running, t2 queued
    expect(queue.runningCount).toBe(1);
    expect(queue.size).toBe(1);

    // Wait for both to complete
    const r1 = await waitForStatus(t1.id, 'completed');
    const r2 = await waitForStatus(t2.id, 'completed');

    expect(r1?.status).toBe('completed');
    expect(r2?.status).toBe('completed');

    // t1 should have started before t2
    expect(new Date(r1!.started_at!).getTime()).toBeLessThanOrEqual(new Date(r2!.started_at!).getTime());

    await daemon.shutdown();
  });

  // CON-04: maxConcurrent=2 runs two tasks simultaneously
  it('should run two tasks simultaneously with maxConcurrent=2', async () => {
    const queue = new TaskQueue({ maxConcurrent: 2, maxQueueSize: 100 });
    const daemon = new TaskDaemon({ taskQueue: queue, taskRepo });

    const t1 = makeTask({ prompt: 'sleep 0.3; echo "t1"' });
    const t2 = makeTask({ prompt: 'sleep 0.3; echo "t2"' });

    taskRepo.create(t1);
    taskRepo.create(t2);

    queue.add(t1);
    queue.add(t2);

    // Both should be running
    expect(queue.runningCount).toBe(2);
    expect(queue.size).toBe(0);

    const r1 = await waitForStatus(t1.id, 'completed');
    const r2 = await waitForStatus(t2.id, 'completed');

    expect(r1?.status).toBe('completed');
    expect(r2?.status).toBe('completed');

    await daemon.shutdown();
  });

  // CON-02: Cancel and complete race
  it('should handle cancel arriving same instant as completion', async () => {
    const queue = new TaskQueue({ maxConcurrent: 1, maxQueueSize: 100 });
    const daemon = new TaskDaemon({ taskQueue: queue, taskRepo });

    const t1 = makeTask({ prompt: 'sleep 0.2; echo "done"' });
    taskRepo.create(t1);
    queue.add(t1);

    // Wait almost until done, then cancel
    await new Promise(r => setTimeout(r, 150));
    daemon.cancelTask(t1.id);

    // Should still clean up properly
    await new Promise(r => setTimeout(r, 500));
    expect(queue.runningCount).toBe(0);

    await daemon.shutdown();
  });

  // REL-07: 20 sequential tasks
  it('should execute 20 sequential tasks without losing any', async () => {
    const queue = new TaskQueue({ maxConcurrent: 1, maxQueueSize: 100 });
    const daemon = new TaskDaemon({ taskQueue: queue, taskRepo });

    const tasks: Task[] = [];
    for (let i = 0; i < 20; i++) {
      const t = makeTask({ prompt: `echo "task-${i}"` });
      tasks.push(t);
      taskRepo.create(t);
      queue.add(t);
    }

    // Wait for all to complete
    for (const t of tasks) {
      const result = await waitForStatus(t.id, 'completed', 30000);
      expect(result?.status).toBe('completed');
      expect(result?.exit_code).toBe(0);
    }

    expect(queue.runningCount).toBe(0);
    expect(queue.size).toBe(0);
    await daemon.shutdown();
  }, 60000);

  // DB-02: Concurrent DB writes from different managers
  it('should handle concurrent DB writes from separate connections', () => {
    const db2 = new DatabaseManager(join(testDir, 'conc.db'));
    const repo2 = new TaskRepository(db2.getDatabase());

    // Write from both repos simultaneously
    const tasks1: Task[] = [];
    const tasks2: Task[] = [];

    for (let i = 0; i < 50; i++) {
      const t1 = makeTask();
      const t2 = makeTask();
      tasks1.push(t1);
      tasks2.push(t2);
      taskRepo.create(t1);
      repo2.create(t2);
    }

    // Both repos should see all 100 tasks
    const allFromRepo1 = taskRepo.list();
    const allFromRepo2 = repo2.list();
    expect(allFromRepo1.length).toBe(100);
    expect(allFromRepo2.length).toBe(100);

    db2.close();
  });
});
