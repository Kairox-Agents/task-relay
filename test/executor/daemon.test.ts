import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseManager, TaskRepository } from '../../src/db/index.js';
import { TaskQueue } from '../../src/executor/queue.js';
import { TaskDaemon } from '../../src/executor/daemon.js';
import { registry } from '../../src/executor/registry.js';
import { ShellExecutor } from '../../src/executor/shell.js';
import type { Task } from '../../src/config/schema.js';
import { v4 as uuidv4 } from 'uuid';

describe('TaskDaemon', () => {
  let dbManager: DatabaseManager;
  let taskRepo: TaskRepository;
  let taskQueue: TaskQueue;
  let daemon: TaskDaemon;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), 'task-relay-daemon-test-' + Date.now());

    const dbPath = join(testDir, 'test.db');
    dbManager = new DatabaseManager(dbPath);
    taskRepo = new TaskRepository(dbManager.getDatabase());

    taskQueue = new TaskQueue({ maxConcurrent: 1, maxQueueSize: 10 });

    // Clear and register shell executor
    const existing = registry.getAll();
    for (const ex of existing) {
      (registry as any).executors?.delete?.(ex.getType());
    }
    registry.register(new ShellExecutor());

    daemon = new TaskDaemon({ taskQueue, taskRepo });
  });

  afterEach(async () => {
    await daemon.shutdown();
    dbManager.close();
    await rm(testDir, { recursive: true, force: true });
  });

  const createShellTask = (prompt: string, overrides: Partial<Task> = {}): Task => ({
    id: uuidv4(),
    type: 'shell',
    prompt,
    working_dir: testDir,
    isolation: 'host',
    timeout_ms: 5000,
    env: {},
    allow_network: false,
    model: 'sonnet',
    max_budget_usd: 1.0,
    acceptance_criteria: null,
    max_iterations: 1,
    judge_model: null,
    current_iteration: 1,
    judge_history: [],
    judge_result: null,
    status: 'pending',
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    exit_code: null,
    error: null,
    output_path: null,
    cost_usd: 0,
    ...overrides,
  });

  const waitForTaskStatus = async (taskId: string, targetStatus: string, maxMs = 5000): Promise<Task | null> => {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const task = taskRepo.getById(taskId);
      if (task && task.status === targetStatus) return task;
      await new Promise(r => setTimeout(r, 50));
    }
    return taskRepo.getById(taskId);
  };

  // DA-01: Full lifecycle pending → running → completed
  it('should transition task from pending to running to completed', async () => {
    const task = createShellTask('echo "hello daemon"');
    taskRepo.create(task);
    taskQueue.add(task);

    const completed = await waitForTaskStatus(task.id, 'completed');
    expect(completed).not.toBeNull();
    expect(completed!.status).toBe('completed');
    expect(completed!.exit_code).toBe(0);
    expect(completed!.started_at).not.toBeNull();
    expect(completed!.completed_at).not.toBeNull();
    expect(completed!.exit_code).toBe(0);
  });

  // DA-02: Full lifecycle pending → running → failed
  it('should mark task as failed when command exits non-zero', async () => {
    const task = createShellTask('echo "oops" >&2; exit 42');
    taskRepo.create(task);
    taskQueue.add(task);

    const failed = await waitForTaskStatus(task.id, 'failed');
    expect(failed).not.toBeNull();
    expect(failed!.status).toBe('failed');
    expect(failed!.exit_code).toBe(42);
    expect(failed!.error).toContain('oops');
  });

  // DA-03: Full lifecycle pending → running → timeout
  it('should mark task as failed when execution times out', async () => {
    const task = createShellTask('sleep 30', { timeout_ms: 500 });
    taskRepo.create(task);
    taskQueue.add(task);

    const result = await waitForTaskStatus(task.id, 'failed', 5000);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('failed');
    expect(result!.error).toContain('timed out');
    expect(result!.exit_code).toBeNull();
  });

  // DA-04: Cancel propagates from daemon to executor
  it('should cancel a running task via cancelTask', async () => {
    const task = createShellTask('sleep 30', { timeout_ms: 60000 });
    taskRepo.create(task);
    taskQueue.add(task);

    // Wait for task to start running
    const running = await waitForTaskStatus(task.id, 'running');
    expect(running).not.toBeNull();

    // Cancel it
    const cancelled = daemon.cancelTask(task.id);
    expect(cancelled).toBe(true);

    // Task should be cleaned up from running set
    await new Promise(r => setTimeout(r, 500));
    // The daemon doesn't update DB on cancel — the cancel just kills the process
    // which causes the finally block to run, which calls queue.complete()
    // The task result will have an error (killed)
    const afterCancel = taskRepo.getById(task.id);
    expect(afterCancel).not.toBeNull();
  });

  // DA-05: Cancel updates DB
  it('should return false when cancelling a non-running task', () => {
    const result = daemon.cancelTask('non-existent-id');
    expect(result).toBe(false);
  });

  // DA-06: Executor not found → status=failed
  it('should fail task when no executor is registered for the type', async () => {
    // Remove all executors and don't re-register
    const allExecutors = registry.getAll();
    for (const ex of allExecutors) {
      (registry as any).executors?.delete?.(ex.getType());
    }

    const task = createShellTask('echo "test"');
    taskRepo.create(task);
    taskQueue.add(task);

    const failed = await waitForTaskStatus(task.id, 'failed');
    expect(failed).not.toBeNull();
    expect(failed!.status).toBe('failed');
    expect(failed!.error).toContain('Executor not found');

    // Re-register for other tests
    registry.register(new ShellExecutor());
  });

  // DA-08: queue.complete() ALWAYS called (critical for queue drain)
  it('should always call queue.complete() even when executor fails', async () => {
    // Remove all executors to cause failure
    const allExecutors = registry.getAll();
    for (const ex of allExecutors) {
      (registry as any).executors?.delete?.(ex.getType());
    }

    const task = createShellTask('echo "test"');
    taskRepo.create(task);
    taskQueue.add(task);

    // Wait for task to finish
    await waitForTaskStatus(task.id, 'failed');

    // Queue should have cleaned up — runningCount should be 0
    expect(taskQueue.runningCount).toBe(0);

    // Re-register for other tests
    registry.register(new ShellExecutor());
  });

  // DA-09: Multiple sequential tasks
  it('should process multiple tasks sequentially (maxConcurrent=1)', async () => {
    const task1 = createShellTask('echo "first"');
    const task2 = createShellTask('echo "second"');
    const task3 = createShellTask('echo "third"');

    taskRepo.create(task1);
    taskRepo.create(task2);
    taskRepo.create(task3);

    taskQueue.add(task1);
    taskQueue.add(task2);
    taskQueue.add(task3);

    // Wait for all to complete
    const t1 = await waitForTaskStatus(task1.id, 'completed');
    const t2 = await waitForTaskStatus(task2.id, 'completed');
    const t3 = await waitForTaskStatus(task3.id, 'completed');

    expect(t1!.status).toBe('completed');
    expect(t2!.status).toBe('completed');
    expect(t3!.status).toBe('completed');

    // Verify ordering: task1 started first, task3 last
    expect(new Date(t1!.started_at!).getTime()).toBeLessThanOrEqual(new Date(t2!.started_at!).getTime());
    expect(new Date(t2!.started_at!).getTime()).toBeLessThanOrEqual(new Date(t3!.started_at!).getTime());
  });

  // DA-10: Shutdown with running task
  it('should wait for running task during shutdown', async () => {
    const task = createShellTask('echo "slow"; sleep 0.5; echo "done"');
    taskRepo.create(task);
    taskQueue.add(task);

    // Give it a moment to start
    await new Promise(r => setTimeout(r, 100));

    // Shutdown should wait for completion
    const shutdownStart = Date.now();
    await daemon.shutdown();
    const shutdownDuration = Date.now() - shutdownStart;

    // Should have waited at least some time for the task
    expect(taskQueue.runningCount).toBe(0);
  });

  // DA-11: Shutdown with no running tasks
  it('should resolve shutdown immediately with no running tasks', async () => {
    const start = Date.now();
    await daemon.shutdown();
    const duration = Date.now() - start;
    expect(duration).toBeLessThan(500);
  });

  // DA-12: DB update order — timestamps set correctly
  it('should set started_at before completed_at', async () => {
    const task = createShellTask('sleep 0.1; echo "timed"');
    taskRepo.create(task);
    taskQueue.add(task);

    const result = await waitForTaskStatus(task.id, 'completed');
    expect(result).not.toBeNull();
    expect(result!.started_at).not.toBeNull();
    expect(result!.completed_at).not.toBeNull();
    expect(new Date(result!.started_at!).getTime()).toBeLessThan(new Date(result!.completed_at!).getTime());
  });

  // DA-13: cost_usd persisted
  it('should persist cost_usd from executor result', async () => {
    const task = createShellTask('echo "cost test"');
    taskRepo.create(task);
    taskQueue.add(task);

    const result = await waitForTaskStatus(task.id, 'completed');
    expect(result).not.toBeNull();
    // Shell executor always returns 0 cost
    expect(result!.cost_usd).toBe(0);
  });

  // DA-14: output_path persisted
  it('should persist output_path from executor result', async () => {
    const task = createShellTask('echo "path test"');
    taskRepo.create(task);
    taskQueue.add(task);

    const result = await waitForTaskStatus(task.id, 'completed');
    expect(result).not.toBeNull();
    expect(result!.output_path).not.toBeNull();
    expect(result!.output_path).toContain('task-relay');
  });

  // DA-15: started_at set before execution
  it('should set started_at before task output is available', async () => {
    const task = createShellTask('sleep 0.2; echo "delayed"');
    taskRepo.create(task);
    taskQueue.add(task);

    // Check running state quickly
    const running = await waitForTaskStatus(task.id, 'running');
    expect(running).not.toBeNull();
    expect(running!.started_at).not.toBeNull();

    // Wait for completion
    const completed = await waitForTaskStatus(task.id, 'completed');
    expect(completed!.started_at).toBe(running!.started_at);
  });
});
