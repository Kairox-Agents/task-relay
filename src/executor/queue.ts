import { EventEmitter } from 'node:events';
import type { Task } from '../config/schema.js';

export interface QueueConfig {
  maxConcurrent: number;
  maxQueueSize: number;
}

export class TaskQueue extends EventEmitter {
  private running: Set<string> = new Set();
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
   * Emits 'task-queued' for queued tasks, 'task-ready' for tasks that can start immediately.
   */
  add(task: Task): boolean {
    if (this.queue.length >= this.config.maxQueueSize) {
      return false;
    }

    if (this.running.size < this.config.maxConcurrent) {
      // Can start immediately
      this.running.add(task.id);
      this.emit('task-ready', task);
    } else {
      // Queue it
      this.queue.push(task);
      this.emit('task-queued', task);
    }

    return true;
  }

  /**
   * Mark a task as completed.
   * This MUST be called by the executor/daemon when a task finishes.
   * Triggers processing of next queued task.
   */
  complete(taskId: string): void {
    this.running.delete(taskId);
    this.emit('task-completed', taskId);
    this.processQueue();
  }

  /**
   * Process the queue: start next task if capacity available.
   */
  private processQueue(): void {
    while (this.running.size < this.config.maxConcurrent && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.running.add(task.id);
      this.emit('task-ready', task);
    }
  }

  /**
   * Clear all pending tasks (not running).
   */
  clear(): void {
    this.queue = [];
  }

  /**
   * Check if a task is currently running.
   */
  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }
}
