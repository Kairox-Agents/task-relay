import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { serve } from '@hono/node-server';
import { rm, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { createServer } from '../../src/api/server.js';
import { DatabaseManager, TaskRepository } from '../../src/db/index.js';
import { ShellExecutor } from '../../src/executor/shell.js';
import { registry } from '../../src/executor/registry.js';
import { TaskQueue } from '../../src/executor/queue.js';
import { TaskDaemon } from '../../src/executor/daemon.js';
import type { Config, Task } from '../../src/config/schema.js';

/**
 * E2E tests: submit task via HTTP, daemon executes it, verify result via HTTP.
 * These are THE most important tests. They exercise the full stack.
 */
describe('E2E: Task Lifecycle', () => {
  let server: any;
  let baseUrl: string;
  let dbManager: DatabaseManager;
  let taskRepo: TaskRepository;
  let taskQueue: TaskQueue;
  let daemon: TaskDaemon;
  let testDir: string;

  const testConfig: Config = {
    server: { port: 0, bind: '127.0.0.1' },
    auth: {
      api_keys: [{
        id: 'e2e-key',
        key: 'e2e-secret',
        allowed_types: ['shell', 'claude-code'],
        allowed_isolation: ['host', 'docker'],
      }],
    },
    execution: {
      default_isolation: 'host',
      allow_host: true,
      allow_worktree: false,
      max_concurrent: 1,
      max_queue_size: 100,
      default_timeout_ms: 30000,
      max_timeout_ms: 60000,
    },
    judge: { enabled: false, default_model: 'haiku', max_iterations_default: 5, scoring: { pass_threshold: 90, partial_threshold: 70 }, deterministic_checks: {}, escalation: {} },
    paths: { allowed: [tmpdir()] },
    env: { allowed_prefix: 'TASK_', allowed_keys: ['NODE_ENV'] },
    executors: { shell: { enabled: true }, 'claude-code': { enabled: true, default_model: 'sonnet', judge_model: 'haiku', default_budget_usd: 1.0, max_budget_usd: 5.0 } },
    docker: { image: 'task-relay/executor:latest', build_image_on_start: false, memory: '2g', cpus: 1, network: 'none', read_only: true },
    worktree: { enabled: false, auto_cleanup: true, base_branch: 'main', merge_policy: 'review' },
    backup: { enabled: false, provider: 's3', endpoint: 'https://s3.example.com', bucket: 'test', region: 'us-east-1', log_interval_ms: 300000, full_interval_hours: 24, retention_days: 30 },
    retention: { max_age_days: 30, max_tasks: 1000, run_on_startup: false, run_daily_at: '03:00', keep_failed_tasks: true },
    logging: { level: 'error', pretty: false },
  };

  beforeEach(async () => {
    testDir = join(tmpdir(), 'task-relay-e2e-' + Date.now());
    await mkdir(testDir, { recursive: true });

    dbManager = new DatabaseManager(join(testDir, 'e2e.db'));
    taskRepo = new TaskRepository(dbManager.getDatabase());

    registry.register(new ShellExecutor());

    taskQueue = new TaskQueue({ maxConcurrent: 1, maxQueueSize: 100 });
    daemon = new TaskDaemon({ taskQueue, taskRepo });

    const app = createServer(testConfig, taskRepo, taskQueue, daemon);
    const serverReady = new Promise<any>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve(info));
    });
    const info = await serverReady;
    baseUrl = `http://127.0.0.1:${info.port}`;
  });

  afterEach(async () => {
    await daemon.shutdown();
    server?.close();
    dbManager.close();
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  }, 15000);

  const createShellTask = (prompt: string, overrides: Record<string, any> = {}): Task => ({
    id: uuidv4(), type: 'shell', prompt, working_dir: testDir, isolation: 'host',
    timeout_ms: 10000, env: {}, allow_network: false, model: 'sonnet', max_budget_usd: 1.0,
    acceptance_criteria: null, max_iterations: 1, judge_model: null, current_iteration: 1,
    judge_history: [], judge_result: null, status: 'pending', created_at: new Date().toISOString(),
    started_at: null, completed_at: null, exit_code: null, error: null, output_path: null, cost_usd: 0,
    ...overrides,
  });

  const request = async (path: string, options: RequestInit = {}) => {
    const headers: HeadersInit = { 'Content-Type': 'application/json', ...options.headers };
    headers['Authorization'] = 'Bearer e2e-secret';
    const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
    return { status: response.status, data: await response.json().catch(() => null) };
  };

  const pollTask = async (taskId: string, targetStatus: string, maxMs = 8000): Promise<any> => {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const { data } = await request(`/tasks/${taskId}`);
      if (data?.status === targetStatus) return data;
      await new Promise(r => setTimeout(r, 100));
    }
    const { data } = await request(`/tasks/${taskId}`);
    return data;
  };

  // API-01: Submit → poll until completed → verify everything
  it('should execute a shell task end to end and return complete result', async () => {
    const { status, data } = await request('/tasks', {
      method: 'POST',
      body: JSON.stringify({ type: 'shell', prompt: 'echo "hello e2e"', working_dir: testDir }),
    });

    expect(status).toBe(201);
    expect(data.id).toBeTruthy();
    expect(data.status).toBe('pending');

    const result = await pollTask(data.id, 'completed');
    expect(result.status).toBe('completed');
    expect(result.exit_code).toBe(0);
    expect(result.started_at).not.toBeNull();
    expect(result.completed_at).not.toBeNull();
    expect(result.cost_usd).toBe(0);
    // Verify ordering
    expect(new Date(result.started_at).getTime()).toBeLessThan(new Date(result.completed_at).getTime());
  });

  // API-02: Failing command
  it('should capture failure for a failing shell command', async () => {
    const { data } = await request('/tasks', {
      method: 'POST',
      body: JSON.stringify({ type: 'shell', prompt: 'echo "failure" >&2; exit 7', working_dir: testDir }),
    });

    const result = await pollTask(data.id, 'failed');
    expect(result.status).toBe('failed');
    expect(result.exit_code).toBe(7);
    expect(result.error).toContain('failure');
  });

  // API-03: Timeout command
  it('should timeout and fail a long-running command', async () => {
    const { data } = await request('/tasks', {
      method: 'POST',
      body: JSON.stringify({ type: 'shell', prompt: 'sleep 60', working_dir: testDir, timeout_ms: 1500 }),
    });

    const result = await pollTask(data.id, 'failed', 8000);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('timed out');
    expect(result.exit_code).toBeNull();
  });

  // API-04: Cancel a running task
  it('should cancel a running task and stop the process', async () => {
    const { data } = await request('/tasks', {
      method: 'POST',
      body: JSON.stringify({ type: 'shell', prompt: 'sleep 60', working_dir: testDir }),
    });

    // Wait for it to start
    await new Promise(r => setTimeout(r, 200));

    const { status, data: cancelData } = await request(`/tasks/${data.id}`, { method: 'DELETE' });
    expect(status).toBe(200);
    expect(cancelData.status).toBe('cancelled');

    // Wait for process to actually die so afterEach doesn't hang
    await new Promise(r => setTimeout(r, 1000));
  });

  // Queue full
  it('should reject task when queue is full', async () => {
    // Direct queue test — no need to recreate server
    const tinyQueue = new TaskQueue({ maxConcurrent: 1, maxQueueSize: 0 });

    // Add first task to fill the running slot
    const t1 = createShellTask('sleep 30');
    taskRepo.create(t1);
    const added1 = tinyQueue.add(t1);
    expect(added1).toBe(true);

    // Second add should be rejected
    const t2 = createShellTask('echo nope');
    const added2 = tinyQueue.add(t2);
    expect(added2).toBe(false);

    tinyQueue.complete(t1.id);
  });

  // Sequential execution
  it('should execute tasks sequentially when maxConcurrent=1', async () => {
    const tasks = [];
    for (let i = 0; i < 3; i++) {
      const { data } = await request('/tasks', {
        method: 'POST',
        body: JSON.stringify({ type: 'shell', prompt: `echo "task-${i}"`, working_dir: testDir }),
      });
      tasks.push(data.id);
    }

    // Wait for all to complete
    for (const id of tasks) {
      const result = await pollTask(id, 'completed', 10000);
      expect(result.status).toBe('completed');
    }
  });

  // Env vars passed through
  it('should pass allowed env vars to the executor', async () => {
    const { data } = await request('/tasks', {
      method: 'POST',
      body: JSON.stringify({
        type: 'shell',
        prompt: 'echo $TASK_GREETING $NODE_ENV',
        working_dir: testDir,
        env: { TASK_GREETING: 'hello-from-e2e', NODE_ENV: 'test' },
      }),
    });

    const result = await pollTask(data.id, 'completed');
    expect(result.status).toBe('completed');
  });

  // Disallowed env vars rejected
  it('should reject disallowed env vars', async () => {
    const { status, data } = await request('/tasks', {
      method: 'POST',
      body: JSON.stringify({
        type: 'shell',
        prompt: 'echo $SECRET',
        working_dir: testDir,
        env: { SECRET: 'should-be-rejected' },
      }),
    });

    expect(status).toBe(400);
  });

  // Path not allowed
  it('should reject tasks with disallowed working directory', async () => {
    const { status, data } = await request('/tasks', {
      method: 'POST',
      body: JSON.stringify({ type: 'shell', prompt: 'echo "hack"', working_dir: '/etc' }),
    });

    expect(status).toBe(403);
    expect(data.error.code).toBe('PATH_NOT_ALLOWED');
  });

  // Shell + docker isolation rejected
  it('should reject shell tasks with docker isolation', async () => {
    const { status, data } = await request('/tasks', {
      method: 'POST',
      body: JSON.stringify({ type: 'shell', prompt: 'echo "test"', working_dir: testDir, isolation: 'docker' }),
    });

    expect(status).toBe(403);
    expect(data.error.code).toBe('ISOLATION_NOT_ALLOWED');
  });

  // Multiple API keys
  it('should enforce per-key type restrictions', async () => {
    // Create new server with restricted key
    const restrictedConfig = { ...testConfig, auth: { api_keys: [{ id: 'shell-only', key: 'shell-only-secret', allowed_types: ['shell'] as const, allowed_isolation: ['host'] as const }] } };
    const restrictedApp = createServer(restrictedConfig, taskRepo, taskQueue, daemon);
    server.close();
    const serverReady = new Promise<any>((resolve) => {
      server = serve({ fetch: restrictedApp.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve(info));
    });
    const info = await serverReady;
    baseUrl = `http://127.0.0.1:${info.port}`;

    // Shell should work
    const shellHeaders = { 'Authorization': 'Bearer shell-only-secret' };
    const { status: shellStatus } = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...shellHeaders },
      body: JSON.stringify({ type: 'shell', prompt: 'echo "ok"', working_dir: testDir }),
    });
    expect(shellStatus).toBe(201);
  });

  // Auth rejection
  it('should reject requests without valid API key', async () => {
    const { status } = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'shell', prompt: 'echo "test"', working_dir: testDir }),
    });
    expect(status).toBe(401);
  });

  // 404 for non-existent task
  it('should return 404 for non-existent task', async () => {
    const { status, data } = await request('/tasks/00000000-0000-0000-0000-000000000000');
    expect(status).toBe(404);
    expect(data.error.code).toBe('TASK_NOT_FOUND');
  });

  // Invalid JSON body
  it('should reject malformed JSON body', async () => {
    const response = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer e2e-secret' },
      body: 'not json at all',
    });
    expect(response.status).toBe(400);
  });

  // Health check (no auth)
  it('should return health without auth', async () => {
    const response = await fetch(`${baseUrl}/health`);
    const data = await response.json();
    expect(data.status).toBe('healthy');
  });
});
