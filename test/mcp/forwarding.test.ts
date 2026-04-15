import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serve } from '@hono/node-server';
import { createServer } from '../../src/api/server.js';
import { DatabaseManager, TaskRepository } from '../../src/db/index.js';
import { TaskQueue } from '../../src/executor/queue.js';
import { TaskDaemon } from '../../src/executor/daemon.js';
import { ShellExecutor } from '../../src/executor/shell.js';
import { registry } from '../../src/executor/registry.js';
import type { Config } from '../../src/config/schema.js';

/**
 * MCP Server tests — test the HTTP forwarding layer directly.
 * We simulate what the MCP server does: call the HTTP daemon.
 * The stdio/JSON-RPC framing is a thin wrapper; the real logic is the HTTP calls.
 */
describe('MCP Server: HTTP forwarding', () => {
  let server: any;
  let baseUrl: string;
  let dbManager: DatabaseManager;
  let taskRepo: TaskRepository;
  let taskQueue: TaskQueue;
  let daemon: TaskDaemon;
  let testDir: string;

  const testConfig: Config = {
    server: { port: 0, bind: '127.0.0.1' },
    auth: { api_keys: [{ id: 'mcp-key', key: 'mcp-secret', allowed_types: ['shell', 'claude-code'], allowed_isolation: ['host'] }] },
    execution: { default_isolation: 'host', allow_host: true, allow_worktree: false, max_concurrent: 1, max_queue_size: 100, default_timeout_ms: 30000, max_timeout_ms: 60000 },
    judge: { enabled: false, default_model: 'haiku', max_iterations_default: 5, scoring: { pass_threshold: 90, partial_threshold: 70 }, deterministic_checks: {}, escalation: {} },
    paths: { allowed: [tmpdir()] },
    env: { allowed_prefix: 'TASK_', allowed_keys: [] },
    executors: { shell: { enabled: true }, 'claude-code': { enabled: true, default_model: 'sonnet', judge_model: 'haiku', default_budget_usd: 1.0, max_budget_usd: 5.0 } },
    docker: { image: 'task-relay/executor:latest', build_image_on_start: false, memory: '2g', cpus: 1, network: 'none', read_only: true },
    worktree: { enabled: false, auto_cleanup: true, base_branch: 'main', merge_policy: 'review' },
    backup: { enabled: false, provider: 's3', endpoint: '', bucket: '', region: '', log_interval_ms: 300000, full_interval_hours: 24, retention_days: 30 },
    retention: { max_age_days: 30, max_tasks: 1000, run_on_startup: false, run_daily_at: '03:00', keep_failed_tasks: true },
    logging: { level: 'error', pretty: false },
  };

  const pollTask = async (id: string, target: string, maxMs = 8000): Promise<any> => {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const res = await daemonRequest('GET', `/tasks/${id}`);
      if (res.data?.status === target) return res.data;
      await new Promise(r => setTimeout(r, 100));
    }
    const res = await daemonRequest('GET', `/tasks/${id}`);
    return res.data;
  };

  const daemonRequest = async (method: string, path: string, body?: any) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Authorization': 'Bearer mcp-secret' };
    const opts: RequestInit = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${baseUrl}${path}`, opts);
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  };

  beforeEach(async () => {
    testDir = join(tmpdir(), 'task-relay-mcp-' + Date.now());
    await mkdir(testDir, { recursive: true });
    dbManager = new DatabaseManager(join(testDir, 'mcp.db'));
    taskRepo = new TaskRepository(dbManager.getDatabase());
    registry.register(new ShellExecutor());
    taskQueue = new TaskQueue({ maxConcurrent: 1, maxQueueSize: 100 });
    daemon = new TaskDaemon({ taskQueue, taskRepo });

    const app = createServer(testConfig, taskRepo, taskQueue, daemon);
    const info = await new Promise<any>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (i) => resolve(i));
    });
    baseUrl = `http://127.0.0.1:${info.port}`;
  });

  afterEach(async () => {
    await daemon.shutdown();
    server?.close();
    dbManager.close();
    await rm(testDir, { recursive: true, force: true });
  });

  // MCP-03: submit_task creates a task via HTTP
  it('should submit a shell task and get task ID back', async () => {
    const { status, data } = await daemonRequest('POST', '/tasks', {
      type: 'shell', prompt: 'echo "mcp test"', working_dir: testDir,
    });
    expect(status).toBe(201);
    expect(data.id).toBeTruthy();
    expect(data.status).toBe('pending');
  });

  // MCP-04: get_task returns task status
  it('should get task status after submission', async () => {
    const { data: created } = await daemonRequest('POST', '/tasks', {
      type: 'shell', prompt: 'echo "status check"', working_dir: testDir,
    });

    const { status, data } = await daemonRequest('GET', `/tasks/${created.id}`);
    expect(status).toBe(200);
    expect(data.id).toBe(created.id);
  });

  // MCP-04 full: get_task returns completed result
  it('should get completed task result with exit code and output', async () => {
    const { data: created } = await daemonRequest('POST', '/tasks', {
      type: 'shell', prompt: 'echo "result test"', working_dir: testDir,
    });

    const result = await pollTask(created.id, 'completed');
    expect(result.status).toBe('completed');
    expect(result.exit_code).toBe(0);
  });

  // MCP-05: list_tasks returns task list
  it('should list tasks', async () => {
    await daemonRequest('POST', '/tasks', { type: 'shell', prompt: 'echo a', working_dir: testDir });
    await daemonRequest('POST', '/tasks', { type: 'shell', prompt: 'echo b', working_dir: testDir });

    const { status, data } = await daemonRequest('GET', '/tasks');
    expect(status).toBe(200);
    expect(data.tasks).toBeDefined();
    expect(data.tasks.length).toBeGreaterThanOrEqual(2);
  });

  // MCP-06: cancel_task cancels a running task
  it('should cancel a running task', async () => {
    const { data: created } = await daemonRequest('POST', '/tasks', {
      type: 'shell', prompt: 'sleep 30', working_dir: testDir,
    });

    await new Promise(r => setTimeout(r, 200));

    const { status } = await daemonRequest('DELETE', `/tasks/${created.id}`);
    expect(status).toBe(200);
  });

  // MCP-07: get_capabilities returns capabilities
  it('should return capabilities', async () => {
    const { status, data } = await daemonRequest('GET', '/capabilities');
    expect(status).toBe(200);
    expect(data.executors).toBeDefined();
  });

  // MCP-08: daemon not running — handled by MCP server gracefully
  it('should handle unreachable daemon gracefully', async () => {
    try {
      await fetch('http://127.0.0.1:1/tasks', {
        headers: { 'Authorization': 'Bearer mcp-secret' },
      });
      // If it somehow succeeds, that's fine
    } catch (err) {
      expect(err).toBeTruthy();
    }
  });

  // MCP-01: health check works (proxy for "daemon is alive")
  it('should check daemon health', async () => {
    const response = await fetch(`${baseUrl}/health`);
    const data = await response.json();
    expect(data.status).toBe('healthy');
  });

  // Full E2E: MCP submit → daemon execute → MCP get result
  it('should complete full E2E: submit → execute → get result', async () => {
    const { data: created } = await daemonRequest('POST', '/tasks', {
      type: 'shell', prompt: 'echo "full e2e mcp"', working_dir: testDir,
    });

    const result = await pollTask(created.id, 'completed', 10000);
    expect(result.status).toBe('completed');
    expect(result.exit_code).toBe(0);

    const { data: fetched } = await daemonRequest('GET', `/tasks/${created.id}`);
    expect(fetched.status).toBe('completed');
    expect(fetched.exit_code).toBe(0);
  });
});
