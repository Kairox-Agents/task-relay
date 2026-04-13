import { EventEmitter } from 'node:events';
import type { Task } from '../config/schema.js';
import type { Executor } from './types.js';

export interface QueueConfig {
  maxConcurrent: number;
  maxQueueSize: number;
}

export class TaskQueue extends EventEmitter {
  private running: Map<string, Promise<void>> = new Map();
  private queue: Task[] = [];
  private config: QueueConfig;

  constructor(config: QueueConfig) {
    super();
    this.config = config;
  }

  /**
   * Get current queue size (pending tasks).
   */
  get size(): number {
    return this.queue.length;
  }

  /**
   * Get number of running tasks.
   */
  get runningCount(): number {
    return this.running.size;
  }

  /**
   * Add a task to the queue.
   * Returns false if queue is full.
   */
  add(task: Task): boolean {
    if (this.queue.length >= this.config.maxQueueSize) {
      return false;
    }

    this.queue.push(task);
    this.processQueue();
    return true;
  }

  /**
   * Process the queue when capacity is available.
   */
  private processQueue(): void {
    while (this.running.size < this.config.maxConcurrent && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.runTask(task);
    }
  }

  /**
   * Run a single task.
   */
  private async runTask(task: Task): Promise<void> {
    const promise = this.executeTask(task);
    this.running.set(task.id, promise);

    try {
      await promise;
    } finally {
      this.running.delete(task.id);
      this.emit('task-completed', task.id);
      this.processQueue(); // Process next task
    }
  }

  /**
   * Execute task logic (to be implemented by daemon).
   */
  private async executeTask(task: Task): Promise<void> {
    // This is a placeholder - the actual execution logic
    // will be handled by the daemon which has access to
    // the executor registry and task repository.
    this.emit('task-start', task);
    // Daemon will handle the actual execution
  }

  /**
   * Wait for all running tasks to complete.
   */
  async drain(): Promise<void> {
    const promises = Array.from(this.running.values());
    await Promise.all(promises);
  }

  /**
   * Clear all pending tasks (not running).
   */
  clear(): void {
    this.queue = [];
  }
}
