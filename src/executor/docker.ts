import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ExecutorResult } from './types.js';

export interface DockerRunOptions {
  image: string;
  workingDir: string;
  timeoutMs: number;
  outputPath: string;
  readOnly?: boolean;
  network?: 'none' | 'bridge';
  memory?: string;
  cpus?: number;
  env?: Record<string, string>;
  command: string[];
  abortSignal?: AbortSignal;
}

export function buildDockerArgs(options: DockerRunOptions): string[] {
  const args: string[] = ['run', '--rm'];

  if (options.network) {
    args.push('--network', options.network);
  }

  if (options.memory) {
    args.push('--memory', options.memory);
  }

  if (options.cpus) {
    args.push('--cpus', String(options.cpus));
  }

  if (options.readOnly) {
    args.push('--read-only');
  }

  args.push('-v', `${options.workingDir}:/workspace`);
  args.push('-w', '/workspace');

  for (const [key, value] of Object.entries(options.env || {})) {
    args.push('-e', `${key}=${value}`);
  }

  args.push(options.image, ...options.command);
  return args;
}

export function runInDocker(options: DockerRunOptions): { wait: () => Promise<ExecutorResult>; cancel: () => void } {
  mkdirSync(dirname(options.outputPath), { recursive: true });

  const args = buildDockerArgs(options);
  const proc = spawn('docker', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

  let stdout = '';
  let stderr = '';
  let resolved = false;
  let timedOut = false;

  const cleanup = () => {
    clearTimeout(timeoutId);
    proc.stdout?.destroy();
    proc.stderr?.destroy();
    try { proc.stdin?.end(); } catch {}
  };

  const timeoutId = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (!resolved) proc.kill('SIGKILL');
    }, 2000);
  }, options.timeoutMs);

  proc.stdout?.on('data', (data) => {
    stdout += data.toString();
  });

  proc.stderr?.on('data', (data) => {
    stderr += data.toString();
  });

  const promise = new Promise<ExecutorResult>((resolve) => {
    const finalize = () => {
      if (resolved) return;
      resolved = true;
      cleanup();

      const combined = stdout + stderr;
      try { writeFileSync(options.outputPath, combined); } catch {}

      resolve({
        exitCode: timedOut ? null : proc.exitCode,
        output: stdout,
        error: timedOut ? 'Execution timed out' : (stderr || null),
        outputPath: options.outputPath,
        costUsd: 0,
      });
    };

    proc.on('exit', finalize);
    proc.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      try { writeFileSync(options.outputPath, err.message); } catch {}
      resolve({
        exitCode: null,
        output: '',
        error: err.message,
        outputPath: options.outputPath,
        costUsd: 0,
      });
    });
  });

  options.abortSignal?.addEventListener('abort', () => {
    if (!resolved) {
      timedOut = true;
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!resolved) proc.kill('SIGKILL');
      }, 2000);
    }
  });

  return {
    wait: () => promise,
    cancel: () => {
      timedOut = true;
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!resolved) proc.kill('SIGKILL');
      }, 2000);
    },
  };
}
