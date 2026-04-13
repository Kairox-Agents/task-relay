import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ShellExecutor } from '../../src/executor/shell.js';
import type { Task } from '../../src/config/schema.js';
import { v4 as uuidv4 } from 'uuid';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('ShellExecutor', () => {
  let executor: ShellExecutor;
  let testDir: string;

  beforeEach(async () => {
    executor = new ShellExecutor();
    testDir = join(tmpdir(), 'task-relay-shell-test-' + Date.now());
    await mkdir(testDir, { recursive: true });
  });

  const createTestTask = (overrides: Partial<Task> = {}): Task => ({
    id: uuidv4(),
    type: 'shell',
    prompt: 'echo "hello world"',
    working_dir: testDir,
    isolation: 'host',
    timeout_ms: 10000,
    env: { TEST_VAR: 'test-value' },
    allow_network: false,
    model: 'sonnet',
    max_budget_usd: 1.0,
    acceptance_criteria: null,
    max_iterations: 5,
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

  describe('getType', () => {
    it('should return "shell"', () => {
      expect(executor.getType()).toBe('shell');
    });
  });

  describe('canHandle', () => {
    it('should handle shell tasks', () => {
      expect(executor.canHandle('shell')).toBe(true);
    });

    it('should not handle other task types', () => {
      expect(executor.canHandle('claude-code')).toBe(false);
      expect(executor.canHandle('python')).toBe(false);
    });
  });

  describe('execute', () => {
    it('should execute successful shell command', async () => {
      const task = createTestTask({ prompt: 'echo "test output"' });

      const handle = executor.execute({
        task,
        workingDir: task.working_dir,
        isolation: task.isolation,
        timeoutMs: task.timeout_ms,
        env: task.env,
      });

      const result = await handle.wait();

      expect(result.exitCode).toBe(0);
      expect(result.error).toBeNull();
      expect(result.output).toContain('test output');
      expect(result.costUsd).toBe(0);
      expect(result.outputPath).toBeTruthy();
    });

    it('should capture stderr for failed commands', async () => {
      const task = createTestTask({ prompt: 'echo "error message" >&2; exit 1' });

      const handle = executor.execute({
        task,
        workingDir: task.working_dir,
        isolation: task.isolation,
        timeoutMs: task.timeout_ms,
        env: task.env,
      });

      const result = await handle.wait();

      expect(result.exitCode).toBe(1);
      expect(result.error).toContain('error message');
    });

    it('should timeout long-running commands', async () => {
      const task = createTestTask({ prompt: 'sleep 10', timeout_ms: 1000 });

      const handle = executor.execute({
        task,
        workingDir: task.working_dir,
        isolation: task.isolation,
        timeoutMs: task.timeout_ms,
        env: task.env,
      });

      const result = await handle.wait();

      expect(result.error).toContain('timed out');
      expect(result.exitCode).toBeNull();
    }, 10000);

    it('should pass environment variables', async () => {
      const task = createTestTask({ prompt: 'echo $TEST_VAR', env: { TEST_VAR: 'custom-value' } });

      const handle = executor.execute({
        task,
        workingDir: task.working_dir,
        isolation: task.isolation,
        timeoutMs: task.timeout_ms,
        env: task.env,
      });

      const result = await handle.wait();

      expect(result.output).toContain('custom-value');
    });

    it('should write output to file', async () => {
      const task = createTestTask({ prompt: 'echo "file output"' });

      const handle = executor.execute({
        task,
        workingDir: task.working_dir,
        isolation: task.isolation,
        timeoutMs: task.timeout_ms,
        env: task.env,
      });

      const result = await handle.wait();

      if (result.outputPath) {
        const fileContent = await readFile(result.outputPath, 'utf-8');
        expect(fileContent).toContain('file output');
      }
    });

    it('should handle invalid commands gracefully', async () => {
      const task = createTestTask({ prompt: 'nonexistent_command_xyz' });

      const handle = executor.execute({
        task,
        workingDir: task.working_dir,
        isolation: task.isolation,
        timeoutMs: task.timeout_ms,
        env: task.env,
      });

      const result = await handle.wait();

      expect(result.exitCode).not.toBe(0);
      expect(result.error).toBeTruthy();
    });
  });

  describe('cancel', () => {
    it('should cancel running task', async () => {
      const task = createTestTask({ prompt: 'sleep 10' });

      const handle = executor.execute({
        task,
        workingDir: task.working_dir,
        isolation: task.isolation,
        timeoutMs: 60000,
        env: task.env,
      });

      // Cancel after a short delay
      await new Promise((resolve) => setTimeout(resolve, 200));
      handle.cancel();

      const result = await handle.wait();

      expect(result.error).toBeTruthy();
    }, 10000);
  });
});
