import type { Executor } from './types.js';

class ExecutorRegistry {
  private executors: Map<string, Executor> = new Map();

  /**
   * Register an executor.
   */
  register(executor: Executor): void {
    this.executors.set(executor.getType(), executor);
  }

  /**
   * Get executor by type.
   */
  get(type: string): Executor | null {
    return this.executors.get(type) || null;
  }

  /**
   * Get all registered executors.
   */
  getAll(): Executor[] {
    return Array.from(this.executors.values());
  }

  /**
   * Find executor that can handle the given task type.
   */
  findExecutor(taskType: string): Executor | null {
    for (const executor of this.executors.values()) {
      if (executor.canHandle(taskType)) {
        return executor;
      }
    }
    return null;
  }
}

export const registry = new ExecutorRegistry();
