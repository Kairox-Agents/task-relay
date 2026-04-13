import type { Task, IsolationMode } from '../config/schema.js';

export interface ExecutorOptions {
  task: Task;
  workingDir: string;
  isolation: IsolationMode;
  timeoutMs: number;
  env?: Record<string, string>;
}

export interface ExecutorResult {
  exitCode: number | null;
  output: string;
  error: string | null;
  outputPath: string | null;
  costUsd: number;
}

export interface ExecutorHandle {
  cancel(): void;
  wait(): Promise<ExecutorResult>;
}

export interface Executor {
  /**
   * Get the executor type identifier.
   */
  getType(): string;

  /**
   * Check if this executor can handle the given task type.
   */
  canHandle(taskType: string): boolean;

  /**
   * Execute a task.
   */
  execute(options: ExecutorOptions): ExecutorHandle;
}
