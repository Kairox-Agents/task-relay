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

    const proc = spawn('sh', ['-c', task.prompt], {
      cwd: workingDir,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';
    let stderr = '';
    let timedOut = false;

    const timeoutId = setTimeout(() => {
      logger.warn({ taskId: task.id }, 'Shell execution timed out, killing process');
      timedOut = true;
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 5000);
    }, timeoutMs);

    proc.stdout?.on('data', (data) => {
      const chunk = data.toString();
      output += chunk;
    });

    proc.stderr?.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
    });

    const promise = new Promise<ExecutorResult>((resolve) => {
      proc.on('close', (code) => {
        clearTimeout(timeoutId);

        const fullOutput = output + stderr;
        writeFileSync(outputPath, fullOutput);

        const result: ExecutorResult = {
          exitCode: timedOut ? null : code,
          output,
          error: timedOut ? 'Execution timed out' : (stderr || null),
          outputPath,
          costUsd: 0, // Shell executor has no cost
        };

        logger.info(
          {
            taskId: task.id,
            exitCode: result.exitCode,
            error: result.error,
          },
          'Shell execution completed'
        );

        resolve(result);
      });

      proc.on('error', (err) => {
        clearTimeout(timeoutId);

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
        clearTimeout(timeoutId);
        proc.kill('SIGTERM');
        setTimeout(() => proc.kill('SIGKILL'), 5000);
      },
      wait: () => promise,
    };
  }
}
