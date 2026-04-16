import type { Task, TaskStatus } from '../config/schema.js';
import type { TaskQueue } from './queue.js';
import type { TaskRepository } from '../db/tasks.js';
import type { BackupManager } from '../backup/manager.js';
import { registry } from './registry.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger();

export interface DaemonOptions {
  taskQueue: TaskQueue;
  taskRepo: TaskRepository;
  backupManager?: BackupManager;
}

export class TaskDaemon {
  private taskQueue: TaskQueue;
  private taskRepo: TaskRepository;
  private backupManager?: BackupManager;
  private running: Map<string, { cancel: () => void }> = new Map();

  constructor(options: DaemonOptions) {
    this.taskQueue = options.taskQueue;
    this.taskRepo = options.taskRepo;
    this.backupManager = options.backupManager;

    // Listen for tasks that are ready to execute
    this.taskQueue.on('task-ready', (task: Task) => {
      this.executeTask(task);
    });
  }

  /**
   * Execute a task using the appropriate executor.
   */
  private async executeTask(task: Task): Promise<void> {
    try {
      // Update task status to running
      this.taskRepo.updateStatus(task.id, 'running');
      this.taskRepo.updateStartedAt(task.id, new Date().toISOString());
      logger.info({ taskId: task.id, type: task.type, isolation: task.isolation }, 'Task started');

      // Find executor
      const executor = registry.findExecutor(task.type);
      if (!executor) {
        throw new Error(`Executor not found for type: ${task.type}`);
      }

      // Execute task
      const handle = executor.execute({
        task,
        workingDir: task.working_dir,
        isolation: task.isolation,
        timeoutMs: task.timeout_ms,
        env: task.env,
      });

      // Store cancel handle
      this.running.set(task.id, { cancel: handle.cancel });

      // Wait for result
      const result = await handle.wait();

      // Update task with results
      this.taskRepo.updateResult(task.id, {
        exit_code: result.exitCode,
        error: result.error,
        output_path: result.outputPath,
        cost_usd: result.costUsd,
      });

      // Determine final status
      let finalStatus: TaskStatus = 'completed';
      if (result.error) {
        finalStatus = 'failed';
      }

      this.taskRepo.updateStatus(task.id, finalStatus);
      this.taskRepo.updateCompletedAt(task.id, new Date().toISOString());

      logger.info(
        {
          taskId: task.id,
          status: finalStatus,
          exitCode: result.exitCode,
          costUsd: result.costUsd,
        },
        'Task completed'
      );

      // Backup agent traces for claude-code tasks
      if (task.type === 'claude-code' && this.backupManager) {
        this.backupManager
          .backupTrace(task.id, task.working_dir)
          .catch((err) => logger.warn({ taskId: task.id, error: err }, 'Trace backup failed'));
      }

    } catch (error) {
      logger.error({ taskId: task.id, error }, 'Task execution failed');

      this.taskRepo.updateStatus(task.id, 'failed');
      this.taskRepo.updateCompletedAt(task.id, new Date().toISOString());
      this.taskRepo.updateResult(task.id, {
        exit_code: null,
        error: error instanceof Error ? error.message : 'Unknown error',
        output_path: null,
        cost_usd: 0,
      });
    } finally {
      this.running.delete(task.id);
      // MUST call complete() so queue processes next task
      this.taskQueue.complete(task.id);
    }
  }

  /**
   * Cancel a running task.
   */
  cancelTask(taskId: string): boolean {
    const handle = this.running.get(taskId);
    if (handle) {
      handle.cancel();
      logger.warn({ taskId }, 'Task cancelled');
      return true;
    }
    return false;
  }

  /**
   * Shutdown: wait for running tasks to complete.
   * Returns a promise that resolves when all running tasks finish.
   */
  async shutdown(): Promise<void> {
    logger.info('Daemon shutting down, waiting for running tasks...');

    // Wait for running set to be empty
    while (this.running.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    logger.info('All tasks completed');

    // Stop backup manager
    if (this.backupManager) {
      await this.backupManager.stop();
    }
  }
}
