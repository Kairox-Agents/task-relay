import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Executor, ExecutorOptions, ExecutorResult, ExecutorHandle } from './types.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger();

export class ShellExecutor implements Executor {
  getType(): string {
    return 'shell';
  }

  canHandle(taskType: string): boolean {
    return taskType === 'shell';
  }

  execute(options: ExecutorOptions): ExecutorHandle {
    const { task, workingDir, timeoutMs, env } = options;
    const outputDir = join(tmpdir(), 'task-relay', task.id);
    mkdirSync(outputDir, { recursive: true });
    const outputPath = join(outputDir, 'output.log');

    logger.info({ taskId: task.id, workingDir, timeoutMs }, 'Starting shell execution');

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn('sh', ['-c', task.prompt], {
        cwd: workingDir,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      // Synchronous spawn errors (e.g., ENOTDIR, ENOENT for cwd)
      const result: ExecutorResult = {
        exitCode: null,
        output: '',
        error: err instanceof Error ? err.message : String(err),
        outputPath,
        costUsd: 0,
      };
      logger.error({ taskId: task.id, error: result.error }, 'Shell execution failed (spawn error)');
      return {
        cancel: () => {},
        wait: () => Promise.resolve(result),
      };
    }

    let output = '';
    let stderr = '';
    let timedOut = false;
    let resolved = false;

    const cleanup = () => {
      clearTimeout(timeoutId);
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      try { proc.stdin?.end(); } catch {}
    };

    const timeoutId = setTimeout(() => {
      logger.warn({ taskId: task.id }, 'Shell execution timed out, killing process');
      timedOut = true;
      proc.kill('SIGTERM');
      // Give process 2s to exit gracefully, then force kill
      setTimeout(() => {
        if (!resolved) {
          proc.kill('SIGKILL');
        }
      }, 2000);
    }, timeoutMs);

    proc.stdout?.on('data', (data) => {
      output += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    const resolveResult = (resolve: (result: ExecutorResult) => void) => {
      if (resolved) return;
      resolved = true;
      cleanup();

      const fullOutput = output + stderr;
      try { writeFileSync(outputPath, fullOutput); } catch {}

      const result: ExecutorResult = {
        exitCode: timedOut ? null : proc.exitCode,
        output,
        error: timedOut ? 'Execution timed out' : (stderr || null),
        outputPath,
        costUsd: 0,
      };

      logger.info(
        { taskId: task.id, exitCode: result.exitCode, error: result.error },
        'Shell execution completed'
      );

      resolve(result);
    };

    const promise = new Promise<ExecutorResult>((resolve) => {
      // Use 'exit' instead of 'close' — 'close' waits for stdio streams
      // which can hang if pipes aren't properly drained
      proc.on('exit', () => {
        resolveResult(resolve);
      });

      proc.on('error', (err) => {
        if (resolved) return;
        resolved = true;
        cleanup();

        const result: ExecutorResult = {
          exitCode: null,
          output: '',
          error: err.message,
          outputPath,
          costUsd: 0,
        };

        logger.error({ taskId: task.id, error: err.message }, 'Shell execution failed');
        resolve(result);
      });
    });

    return {
      cancel: () => {
        timedOut = true;
        cleanup();
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!resolved) proc.kill('SIGKILL');
        }, 2000);
      },
      wait: () => promise,
    };
  }
}
