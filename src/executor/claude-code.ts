import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Executor, ExecutorOptions, ExecutorResult, ExecutorHandle } from './types.js';
import type { Task } from '../config/schema.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger();

/**
 * Claude Code executor using the Agent SDK as primary backend.
 * Falls back to CLI subprocess if SDK is unavailable.
 */
export class ClaudeCodeExecutor implements Executor {
  getType(): string {
    return 'claude-code';
  }

  canHandle(taskType: string): boolean {
    return taskType === 'claude-code';
  }

  execute(options: ExecutorOptions): ExecutorHandle {
    const { task, workingDir, timeoutMs, env } = options;
    const outputDir = join(tmpdir(), 'task-relay', task.id);
    mkdirSync(outputDir, { recursive: true });
    const outputPath = join(outputDir, 'output.log');

    logger.info(
      { taskId: task.id, workingDir, timeoutMs, model: task.model },
      'Starting Claude Code execution'
    );

    // Try SDK first, fall back to CLI
    let cancelled = false;
    let abortController = new AbortController();

    const promise = (async (): Promise<ExecutorResult> => {
      try {
        return await this.executeWithSDK(task, workingDir, env, timeoutMs, outputPath, abortController);
      } catch (sdkError) {
        logger.warn(
          { taskId: task.id, error: sdkError instanceof Error ? sdkError.message : 'SDK failed' },
          'SDK execution failed, trying CLI fallback'
        );

        if (cancelled) {
          return {
            exitCode: null,
            output: '',
            error: 'Execution cancelled',
            outputPath,
            costUsd: 0,
          };
        }

        // Fallback to CLI
        return await this.executeWithCLI(task, workingDir, env, timeoutMs, outputPath, abortController);
      }
    })();

    return {
      cancel: () => {
        cancelled = true;
        abortController.abort();
        logger.warn({ taskId: task.id }, 'Claude Code execution cancelled');
      },
      wait: () => promise,
    };
  }

  /**
   * Execute using the Claude Agent SDK (primary).
   */
  private async executeWithSDK(
    task: Task,
    _workingDir: string,
    _env: Record<string, string> | undefined,
    timeoutMs: number,
    outputPath: string,
    abortController: AbortController
  ): Promise<ExecutorResult> {
    // Dynamic import so the module loads only if SDK is installed
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    let output = '';
    let costUsd = 0;
    let timedOut = false;

    const timeoutId = setTimeout(() => {      timedOut = true;
      abortController.abort();
      logger.warn({ taskId: task.id }, 'Claude Code SDK execution timed out');
    }, timeoutMs);

    try {
      const sdkOptions: Record<string, unknown> = {
        allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'LS'],
        permissionMode: 'acceptEdits',
        systemPrompt: this.buildSystemPrompt(task),
        maxTurns: 50,
      };

      // Set working directory via cwd env
      // TODO: SDK doesn't support cwd option yet; will be needed for Docker mode

      for await (const message of query({
        prompt: task.prompt,
        options: sdkOptions as any,
      })) {
        if (abortController.signal.aborted) break;

        if (message.type === 'assistant' && (message as any).message?.content) {
          for (const block of (message as any).message.content) {
            if ('text' in block) {
              output += block.text + '\n';
            } else if ('name' in block) {
              output += `[Tool: ${block.name}]\n`;
            }
          }
        }

        if (message.type === 'result') {
          const result = message as any;
          costUsd = result.total_cost_usd || 0;

          if (result.subtype === 'error') {
            throw new Error(result.error || 'Claude Code returned an error result');
          }
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }

    // Write output to file
    try { writeFileSync(outputPath, output); } catch {}

    return {
      exitCode: timedOut ? null : 0,
      output,
      error: timedOut ? 'Execution timed out' : null,
      outputPath,
      costUsd,
    };
  }

  /**
   * Execute using the CLI subprocess (fallback).
   */
  private async executeWithCLI(
    task: Task,
    workingDir: string,
    env: Record<string, string> | undefined,
    timeoutMs: number,
    outputPath: string,
    abortController: AbortController
  ): Promise<ExecutorResult> {
    const args = [
      '-p', task.prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--max-budget-usd', task.max_budget_usd.toFixed(2),
      '--session-id', task.id,
    ];

    if (task.model) {
      args.push('--model', task.model);
    }

    const execEnv = { ...process.env, ...env };

    return new Promise<ExecutorResult>((resolve) => {
      const proc = spawn('claude', args, {
        cwd: workingDir,
        env: execEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
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
        timedOut = true;
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!resolved) proc.kill('SIGKILL');
        }, 2000);
      }, timeoutMs);

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      const finalize = () => {
        if (resolved) return;
        resolved = true;
        cleanup();

        // Parse cost from stream-json output
        let costUsd = 0;
        try {
          const lines = stdout.split('\n').filter(Boolean);
          for (const line of lines) {
            const parsed = JSON.parse(line);
            if (parsed.type === 'result' && parsed.cost_usd) {
              costUsd = parsed.cost_usd;
            }
          }
        } catch {}

        // Write output to file
        try { writeFileSync(outputPath, stdout + stderr); } catch {}

        const result: ExecutorResult = {
          exitCode: timedOut ? null : proc.exitCode,
          output: stdout,
          error: timedOut ? 'Execution timed out' : (stderr || null),
          outputPath,
          costUsd,
        };

        logger.info(
          { taskId: task.id, exitCode: result.exitCode, costUsd: result.costUsd },
          'Claude Code CLI execution completed'
        );

        resolve(result);
      };

      proc.on('exit', () => finalize());
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

        resolve(result);
      });

      // Handle abort
      abortController.signal.addEventListener('abort', () => {
        if (!resolved) {
          timedOut = true;
          proc.kill('SIGTERM');
          setTimeout(() => {
            if (!resolved) proc.kill('SIGKILL');
          }, 2000);
        }
      });
    });
  }

  /**
   * Build system prompt for the agent.
   */
  private buildSystemPrompt(task: Task): string {
    let prompt = `You are a task executor running inside task-relay. Execute the given task precisely and efficiently.`;

    if (task.acceptance_criteria) {
      prompt += `\n\nAcceptance criteria:\n${task.acceptance_criteria}`;
    }

    return prompt;
  }
}
