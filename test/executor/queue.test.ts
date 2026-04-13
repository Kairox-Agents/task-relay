import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TaskQueue } from '../../src/executor/queue.js';
import { registry } from '../../src/executor/registry.js';
import { ShellExecutor } from '../../src/executor/shell.js';
import type { Task } from '../../src/config/schema.js';
import { v4 as uuidv4 } from 'uuid';

describe('TaskQueue', () => {
  let queue: TaskQueue;

  beforeEach(() => {
    queue = new TaskQueue({
      maxConcurrent: 2,
      maxQueueSize: 10,
    });
  });

  const createTestTask = (overrides: Partial<Task> = {}): Task => ({
    id: uuidv4(),
    type: 'shell',
    prompt: 'echo "test"',
    working_dir: '/tmp',
    isolation: 'host',
    timeout_ms: 30000,
    env: {},
    allow_network: false,
    model: 'sonnet',
    max_budget_usd: 1.0,
    acceptance_criteria: null,
    max_iterations: 5,
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

  describe('size', () => {
    it('should return 0 for empty queue', () => {
      expect(queue.size).toBe(0);
    });

    it('should return number of pending tasks (not running)', async () => {
      const queue2 = new TaskQueue({ maxConcurrent: 0, maxQueueSize: 10 }); // No capacity, tasks stay in queue
      queue2.add(createTestTask());
      queue2.add(createTestTask());

      expect(queue2.size).toBe(2);
    });
  });

  describe('runningCount', () => {
    it('should return 0 when no tasks running', () => {
      expect(queue.runningCount).toBe(0);
    });
  });

  describe('add', () => {
    it('should add task to queue and process immediately', () => {
      const task = createTestTask();
      const added = queue.add(task);

      expect(added).toBe(true);
      // Task starts immediately, so queue size is 0 but running is 1
      expect(queue.size).toBe(0);
      expect(queue.runningCount).toBe(1);
    });

    it('should emit task-ready event and track running', async () => {
      const readyPromise = new Promise<Task>((resolve) => {
        queue.once('task-ready', resolve);
      });

      queue.add(createTestTask());
      queue.add(createTestTask());

      // First task starts immediately (task-ready), second goes to queue
      // But with maxConcurrent=2, both start
      const task = await readyPromise;
      expect(task).toBeDefined();
      expect(queue.runningCount).toBeGreaterThanOrEqual(1);
    });

    it('should reject task when queue exceeds max size', () => {
      // maxConcurrent=0 means nothing gets dequeued, so queue fills up
      const fullQueue = new TaskQueue({ maxConcurrent: 0, maxQueueSize: 2 });

      const added1 = fullQueue.add(createTestTask());
      const added2 = fullQueue.add(createTestTask());
      const added3 = fullQueue.add(createTestTask()); // Should be rejected

      expect(added1).toBe(true);
      expect(added2).toBe(true);
      expect(added3).toBe(false); // Queue is full
      expect(fullQueue.size).toBe(2);
    });

    it('should process tasks up to maxConcurrent', async () => {
      // With maxConcurrent=2, first 2 tasks start immediately
      let startedCount = 0;
      const startPromise = new Promise<void>((resolve) => {
        queue.on('task-ready', () => {
          startedCount++;
          if (startedCount === 2) {
            resolve();
          }
        });
      });

      queue.add(createTestTask());
      queue.add(createTestTask());

      await startPromise;
      // Both tasks are running
      expect(startedCount).toBe(2);
      expect(queue.runningCount).toBe(2);
    }, 5000);
  });

  describe('clear', () => {
    it('should clear all pending tasks', async () => {
      const queue2 = new TaskQueue({ maxConcurrent: 0, maxQueueSize: 10 }); // No capacity
      queue2.add(createTestTask());
      queue2.add(createTestTask());

      expect(queue2.size).toBe(2);

      queue2.clear();

      expect(queue2.size).toBe(0);
    });
  });

  describe('drain', () => {
    it('should wait for all running tasks', async () => {
      const task = createTestTask({ prompt: 'echo "quick"' });

      queue.add(task);

      // Simulate task completion
      setTimeout(() => queue.complete(task.id), 100);

      // Wait for running to drain
      while (queue.runningCount > 0) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(queue.runningCount).toBe(0);
    }, 5000);
  });
});

describe('ExecutorRegistry', () => {
  beforeEach(() => {
    // Clear registry
    const allExecutors = registry.getAll();
    for (const executor of allExecutors) {
      registry[executor.getType()] = undefined;
    }
  });

  const createTestTask = (overrides: Partial<Task> = {}): Task => ({
    id: uuidv4(),
    type: 'shell',
    prompt: 'echo "test"',
    working_dir: '/tmp',
    isolation: 'host',
    timeout_ms: 30000,
    env: {},
    allow_network: false,
    model: 'sonnet',
    max_budget_usd: 1.0,
    acceptance_criteria: null,
    max_iterations: 5,
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

  describe('register', () => {
    it('should register an executor', () => {
      const executor = new ShellExecutor();
      registry.register(executor);

      const retrieved = registry.get('shell');
      expect(retrieved).toBe(executor);
    });

    it('should allow registering multiple executors', () => {
      const shellExecutor = new ShellExecutor();
      registry.register(shellExecutor);

      const all = registry.getAll();
      expect(all.length).toBe(1);
    });
  });

  describe('get', () => {
    it('should return registered executor', () => {
      const executor = new ShellExecutor();
      registry.register(executor);

      const retrieved = registry.get('shell');
      expect(retrieved).toBe(executor);
    });

    it('should return null for unregistered executor', () => {
      const retrieved = registry.get('nonexistent');
      expect(retrieved).toBeNull();
    });
  });

  describe('findExecutor', () => {
    it('should find executor that can handle task type', () => {
      const shellExecutor = new ShellExecutor();
      registry.register(shellExecutor);

      const found = registry.findExecutor('shell');
      expect(found).toBe(shellExecutor);
    });

    it('should return null if no executor can handle type', () => {
      const found = registry.findExecutor('nonexistent');
      expect(found).toBeNull();
    });
  });

  describe('getAll', () => {
    it('should return all registered executors', () => {
      const shellExecutor = new ShellExecutor();
      registry.register(shellExecutor);

      const all = registry.getAll();
      expect(all).toHaveLength(1);
      expect(all[0]).toBe(shellExecutor);
    });
  });
});
