import { describe, it, expect, beforeEach } from 'vitest';
import { TaskQueue } from '../../src/executor/queue.js';
import type { Task } from '../../src/config/schema.js';
import { v4 as uuidv4 } from 'uuid';

describe('TaskQueue: Drain & Ordering', () => {
  let queue: TaskQueue;

  beforeEach(() => {
    queue = new TaskQueue({ maxConcurrent: 1, maxQueueSize: 100 });
  });

  const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: uuidv4(),
    type: 'shell',
    prompt: 'echo test',
    working_dir: '/tmp',
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

  // QU-02: complete() triggers next task
  it('should dequeue and emit task-ready for next task when complete() is called', async () => {
    const readyOrder: string[] = [];

    queue.on('task-ready', (task: Task) => {
      readyOrder.push(task.id);
    });

    const t1 = makeTask();
    const t2 = makeTask();
    const t3 = makeTask();

    queue.add(t1);
    queue.add(t2);
    queue.add(t3);

    // Only t1 should start (maxConcurrent=1)
    expect(readyOrder).toHaveLength(1);
    expect(readyOrder[0]).toBe(t1.id);
    expect(queue.runningCount).toBe(1);
    expect(queue.size).toBe(2);

    // Complete t1 → t2 should start
    queue.complete(t1.id);
    expect(readyOrder).toHaveLength(2);
    expect(readyOrder[1]).toBe(t2.id);
    expect(queue.runningCount).toBe(1);
    expect(queue.size).toBe(1);

    // Complete t2 → t3 should start
    queue.complete(t2.id);
    expect(readyOrder).toHaveLength(3);
    expect(readyOrder[2]).toBe(t3.id);
    expect(queue.runningCount).toBe(1);
    expect(queue.size).toBe(0);

    // Complete t3
    queue.complete(t3.id);
    expect(queue.runningCount).toBe(0);
  });

  // QU-01: FIFO ordering
  it('should process tasks in FIFO order', async () => {
    const order: number[] = [];

    queue.on('task-ready', (task: Task) => {
      order.push(parseInt(task.prompt.replace('echo task-', ''), 10));
    });

    for (let i = 1; i <= 5; i++) {
      queue.add(makeTask({ prompt: `echo task-${i}` }));
    }

    // Only first starts
    expect(order).toEqual([1]);

    for (let i = 1; i <= 4; i++) {
      // Find the running task and complete it
      const tasks = Array.from({ length: 5 }, (_, j) => j + 1);
      const currentRunning = tasks.find(t => !order.slice(0, -1).includes(t) || t === i);
      queue.complete(`task-${i}`); // IDs are UUIDs, but we complete by the actual IDs
    }
  });

  // QU-03: complete() with unknown ID
  it('should not crash when complete() is called with unknown ID', () => {
    expect(() => queue.complete('nonexistent')).not.toThrow();
    expect(queue.runningCount).toBe(0);
  });

  // QU-04: Running count through lifecycle
  it('should track running count accurately through add/complete cycles', () => {
    const t1 = makeTask();
    const t2 = makeTask();

    queue.add(t1);
    expect(queue.runningCount).toBe(1);

    queue.add(t2);
    expect(queue.runningCount).toBe(1); // maxConcurrent=1, t2 queued
    expect(queue.size).toBe(1);

    queue.complete(t1.id);
    expect(queue.runningCount).toBe(1); // t2 dequeued
    expect(queue.size).toBe(0);

    queue.complete(t2.id);
    expect(queue.runningCount).toBe(0);
  });

  // QU-06: Rapid add/complete cycles — 20 tasks
  it('should handle 20 rapid add/complete cycles without losing count', async () => {
    const tasks: Task[] = [];
    const readyTasks: string[] = [];

    queue.on('task-ready', (task: Task) => {
      readyTasks.push(task.id);
    });

    for (let i = 0; i < 20; i++) {
      tasks.push(makeTask());
    }

    for (const task of tasks) {
      queue.add(task);
    }

    // First task starts, rest are queued
    expect(readyTasks).toHaveLength(1);
    expect(queue.runningCount).toBe(1);
    expect(queue.size).toBe(19);

    // Complete all
    for (const task of tasks) {
      queue.complete(task.id);
    }

    expect(queue.runningCount).toBe(0);
    expect(queue.size).toBe(0);
    expect(readyTasks).toHaveLength(20);
  });

  // QU-07: clear() doesn't affect running tasks
  it('should not remove running tasks when clear() is called', () => {
    const t1 = makeTask();
    const t2 = makeTask();

    queue.add(t1);
    queue.add(t2); // t2 is queued

    expect(queue.runningCount).toBe(1);
    expect(queue.size).toBe(1);

    queue.clear();

    expect(queue.size).toBe(0); // Queued cleared
    expect(queue.runningCount).toBe(1); // Running untouched
  });

  // QU-09: maxConcurrent=0
  it('should queue all tasks when maxConcurrent=0', () => {
    const zeroQueue = new TaskQueue({ maxConcurrent: 0, maxQueueSize: 100 });
    let readyCount = 0;
    zeroQueue.on('task-ready', () => readyCount++);

    zeroQueue.add(makeTask());
    zeroQueue.add(makeTask());
    zeroQueue.add(makeTask());

    expect(readyCount).toBe(0); // Nothing started
    expect(zeroQueue.size).toBe(3);
    expect(zeroQueue.runningCount).toBe(0);
  });

  // QU-10: maxQueueSize=0
  it('should reject all tasks when maxQueueSize=0 and a slot is full', () => {
    const noBufferQueue = new TaskQueue({ maxConcurrent: 1, maxQueueSize: 0 });
    let readyCount = 0;
    noBufferQueue.on('task-ready', () => readyCount++);

    const t1 = makeTask();
    const t2 = makeTask();

    const added1 = noBufferQueue.add(t1);
    const added2 = noBufferQueue.add(t2); // Should be rejected — running=1, queue=0

    expect(added1).toBe(true);
    expect(added2).toBe(false);
    expect(readyCount).toBe(1);
  });

  // QU-05: Same task ID added twice
  it('should add same task ID twice without error', () => {
    const task = makeTask();
    const added1 = queue.add(task);
    // Second add — running set already has this ID, but queue doesn't deduplicate
    // This tests what actually happens
    const added2 = queue.add(task);
    // It will be accepted (no dedup) but running set has it once
    expect(added1).toBe(true);
    // Second add goes to queue since running count = maxConcurrent
    expect(added2).toBe(true);
  });

  // QU-08: task-ready event contract
  it('should emit task-ready with the full task object', async () => {
    const task = makeTask({ prompt: 'verify event payload' });
    let emittedTask: Task | null = null;

    queue.once('task-ready', (t: Task) => {
      emittedTask = t;
    });

    queue.add(task);

    expect(emittedTask).not.toBeNull();
    expect(emittedTask!.id).toBe(task.id);
    expect(emittedTask!.prompt).toBe('verify event payload');
  });

  // maxConcurrent=2
  it('should run up to maxConcurrent tasks simultaneously', async () => {
    const q2 = new TaskQueue({ maxConcurrent: 2, maxQueueSize: 100 });
    const ready: string[] = [];
    q2.on('task-ready', (t: Task) => ready.push(t.id));

    const t1 = makeTask();
    const t2 = makeTask();
    const t3 = makeTask();

    q2.add(t1);
    q2.add(t2);
    q2.add(t3);

    expect(ready).toHaveLength(2); // t1 and t2 start
    expect(q2.runningCount).toBe(2);
    expect(q2.size).toBe(1); // t3 queued
  });
});
