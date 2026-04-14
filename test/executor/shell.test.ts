import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ShellExecutor } from '../../src/executor/shell.js';
import type { Task } from '../../src/config/schema.js';
import { v4 as uuidv4 } from 'uuid';
import { mkdir, rm, readFile, stat } from 'node:fs/promises';
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

// === NEW: Shell executor gap tests (P0) ===

describe('ShellExecutor: compound commands', () => {
  let executor: ShellExecutor;
  let testDir: string;

  beforeEach(async () => {
    executor = new ShellExecutor();
    testDir = join(tmpdir(), 'task-relay-shell-gap-' + Date.now());
    await mkdir(testDir, { recursive: true });
  });

  const createTask = (overrides: Partial<Task> = {}): Task => ({
    id: uuidv4(), type: 'shell', prompt: 'echo test', working_dir: testDir, isolation: 'host',
    timeout_ms: 10000, env: {}, allow_network: false, model: 'sonnet', max_budget_usd: 1.0,
    acceptance_criteria: null, max_iterations: 1, judge_model: null, current_iteration: 1,
    judge_history: [], judge_result: null, status: 'pending', created_at: new Date().toISOString(),
    started_at: null, completed_at: null, exit_code: null, error: null, output_path: null, cost_usd: 0,
    ...overrides,
  });

  it('should execute compound commands with &&', async () => {
    const handle = executor.execute({ task: createTask({ prompt: 'echo "a" && echo "b" && echo "c"' }), workingDir: testDir, isolation: 'host', timeoutMs: 10000, env: {} });
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('a');
    expect(result.output).toContain('b');
    expect(result.output).toContain('c');
  });

  it('should execute piped commands', async () => {
    const handle = executor.execute({ task: createTask({ prompt: 'echo "hello world" | grep hello' }), workingDir: testDir, isolation: 'host', timeoutMs: 10000, env: {} });
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('hello');
  });

  it('should handle output redirection', async () => {
    const outFile = join(testDir, 'redir.txt');
    const handle = executor.execute({ task: createTask({ prompt: `echo "redirected" > "${outFile}"` }), workingDir: testDir, isolation: 'host', timeoutMs: 10000, env: {} });
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    const content = await readFile(outFile, 'utf-8');
    expect(content).toContain('redirected');
  });

  it('should execute command substitution', async () => {
    const handle = executor.execute({ task: createTask({ prompt: 'echo "host: $(hostname)"' }), workingDir: testDir, isolation: 'host', timeoutMs: 10000, env: {} });
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('host:');
  });
});

describe('ShellExecutor: special characters & output', () => {
  let executor: ShellExecutor;
  let testDir: string;

  beforeEach(async () => {
    executor = new ShellExecutor();
    testDir = join(tmpdir(), 'task-relay-shell-gap-' + Date.now());
    await mkdir(testDir, { recursive: true });
  });

  const createTask = (overrides: Partial<Task> = {}): Task => ({
    id: uuidv4(), type: 'shell', prompt: 'echo test', working_dir: testDir, isolation: 'host',
    timeout_ms: 10000, env: {}, allow_network: false, model: 'sonnet', max_budget_usd: 1.0,
    acceptance_criteria: null, max_iterations: 1, judge_model: null, current_iteration: 1,
    judge_history: [], judge_result: null, status: 'pending', created_at: new Date().toISOString(),
    started_at: null, completed_at: null, exit_code: null, error: null, output_path: null, cost_usd: 0,
    ...overrides,
  });

  it('should handle unicode output', async () => {
    const handle = executor.execute({ task: createTask({ prompt: 'echo "hello 世界 🌍"' }), workingDir: testDir, isolation: 'host', timeoutMs: 10000, env: {} });
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('世界');
  });

  it('should handle commands with no output', async () => {
    const handle = executor.execute({ task: createTask({ prompt: 'true' }), workingDir: testDir, isolation: 'host', timeoutMs: 10000, env: {} });
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('');
    expect(result.error).toBeNull();
  });

  it('should handle large output', async () => {
    const handle = executor.execute({ task: createTask({ prompt: 'seq 1 10000' }), workingDir: testDir, isolation: 'host', timeoutMs: 10000, env: {} });
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    expect(result.output.length).toBeGreaterThan(10000);
  });

  it('should handle special characters in prompts', async () => {
    const prompts = [
      'echo "dollar: $HOME"',
      'echo "exclamation!"',
      'echo "backslash: \\\\"',
    ];
    for (const prompt of prompts) {
      const handle = executor.execute({ task: createTask({ prompt }), workingDir: testDir, isolation: 'host', timeoutMs: 10000, env: {} });
      const result = await handle.wait();
      expect(result.exitCode).toBe(0);
    }
  });
});

describe('ShellExecutor: working directory edge cases', () => {
  let executor: ShellExecutor;
  let testDir: string;

  beforeEach(async () => {
    executor = new ShellExecutor();
    testDir = join(tmpdir(), 'task-relay-shell-gap-' + Date.now());
    await mkdir(testDir, { recursive: true });
  });

  const createTask = (overrides: Partial<Task> = {}): Task => ({
    id: uuidv4(), type: 'shell', prompt: 'echo test', working_dir: testDir, isolation: 'host',
    timeout_ms: 10000, env: {}, allow_network: false, model: 'sonnet', max_budget_usd: 1.0,
    acceptance_criteria: null, max_iterations: 1, judge_model: null, current_iteration: 1,
    judge_history: [], judge_result: null, status: 'pending', created_at: new Date().toISOString(),
    started_at: null, completed_at: null, exit_code: null, error: null, output_path: null, cost_usd: 0,
    ...overrides,
  });

  it('should fail when working dir does not exist', async () => {
    const handle = executor.execute({ task: createTask({ working_dir: '/nonexistent/path/xyz' }), workingDir: '/nonexistent/path/xyz', isolation: 'host', timeoutMs: 10000, env: {} });
    const result = await handle.wait();
    expect(result.error).toBeTruthy();
  });

  it('should fail when working dir is a file', async () => {
    const filePath = join(testDir, 'afile.txt');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(filePath, 'not a directory');
    const handle = executor.execute({ task: createTask({ working_dir: filePath }), workingDir: filePath, isolation: 'host', timeoutMs: 10000, env: {} });
    const result = await handle.wait();
    expect(result.error).toBeTruthy();
  });
});

describe('ShellExecutor: cancel edge cases', () => {
  let executor: ShellExecutor;
  let testDir: string;

  beforeEach(async () => {
    executor = new ShellExecutor();
    testDir = join(tmpdir(), 'task-relay-shell-gap-' + Date.now());
    await mkdir(testDir, { recursive: true });
  });

  const createTask = (overrides: Partial<Task> = {}): Task => ({
    id: uuidv4(), type: 'shell', prompt: 'echo test', working_dir: testDir, isolation: 'host',
    timeout_ms: 10000, env: {}, allow_network: false, model: 'sonnet', max_budget_usd: 1.0,
    acceptance_criteria: null, max_iterations: 1, judge_model: null, current_iteration: 1,
    judge_history: [], judge_result: null, status: 'pending', created_at: new Date().toISOString(),
    started_at: null, completed_at: null, exit_code: null, error: null, output_path: null, cost_usd: 0,
    ...overrides,
  });

  it('should handle immediate cancel', async () => {
    const handle = executor.execute({ task: createTask({ prompt: 'sleep 10' }), workingDir: testDir, isolation: 'host', timeoutMs: 60000, env: {} });
    handle.cancel();
    const result = await handle.wait();
    expect(result.error).toBeTruthy();
  });

  it('should SIGKILL process that ignores SIGTERM', async () => {
    const handle = executor.execute({ task: createTask({ prompt: 'trap "" TERM; sleep 30', timeout_ms: 5000 }), workingDir: testDir, isolation: 'host', timeoutMs: 5000, env: {} });
    await new Promise(r => setTimeout(r, 300));
    handle.cancel();
    const result = await handle.wait();
    expect(result.error).toBeTruthy();
  }, 10000);
});
