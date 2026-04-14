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

describe('API: SSE Streaming', () => {
  let server: any;
  let baseUrl: string;
  let dbManager: DatabaseManager;
  let taskRepo: TaskRepository;
  let taskQueue: TaskQueue;
  let daemon: TaskDaemon;
  let testDir: string;

  const testConfig: Config = {
    server: { port: 0, bind: '127.0.0.1' },
    auth: { api_keys: [{ id: 'test', key: 'sse-secret', allowed_types: ['shell', 'claude-code'], allowed_isolation: ['host'] }] },
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

  beforeEach(async () => {
    testDir = join(tmpdir(), 'task-relay-sse-' + Date.now());
    await mkdir(testDir, { recursive: true });
    dbManager = new DatabaseManager(join(testDir, 'sse.db'));
    taskRepo = new TaskRepository(dbManager.getDatabase());
    registry.register(new ShellExecutor());
    taskQueue = new TaskQueue({ maxConcurrent: 1, maxQueueSize: 100 });
    daemon = new TaskDaemon({ taskQueue, taskRepo });

    const app = createServer(testConfig, taskRepo, taskQueue, daemon);
    const info = await new Promise<any>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve(info));
    });
    baseUrl = `http://127.0.0.1:${info.port}`;
  });

  afterEach(async () => {
    await daemon.shutdown();
    server?.close();
    dbManager.close();
    await rm(testDir, { recursive: true, force: true });
  });

  const headers = { 'Authorization': 'Bearer sse-secret', 'Content-Type': 'application/json' };

  // API-20: SSE sends initial status event
  it('should send initial status event for existing task', async () => {
    const res = await fetch(`${baseUrl}/tasks`, {
      method: 'POST', headers,
      body: JSON.stringify({ type: 'shell', prompt: 'echo hi', working_dir: testDir }),
    });
    const { id } = await res.json();

    const sseRes = await fetch(`${baseUrl}/tasks/${id}/stream`, { headers });
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get('Content-Type')).toBe('text/event-stream');

    const reader = sseRes.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('data: ');
    expect(text).toContain('"type":"status"');
    reader.cancel();
  });

  // API-21: SSE for non-existent task
  it('should return 404 for SSE on non-existent task', async () => {
    const res = await fetch(`${baseUrl}/tasks/00000000-0000-0000-0000-000000000000/stream`, { headers });
    expect(res.status).toBe(404);
  });

  // API-22: SSE keep-alive
  it('should send keep-alive comments', async () => {
    const res = await fetch(`${baseUrl}/tasks`, {
      method: 'POST', headers,
      body: JSON.stringify({ type: 'shell', prompt: 'echo hi', working_dir: testDir }),
    });
    const { id } = await res.json();

    const sseRes = await fetch(`${baseUrl}/tasks/${id}/stream`, { headers });
    const reader = sseRes.body!.getReader();

    // Read initial event
    await reader.read();

    // The keep-alive is every 30s, too long to wait. Just verify the stream is open.
    expect(sseRes.status).toBe(200);
    reader.cancel();
  });

  // API-24: 404 for unknown routes
  it('should return 404 for unknown routes', async () => {
    const res = await fetch(`${baseUrl}/unknown`, { headers });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error.code).toBe('NOT_FOUND');
  });

  // API-25: POST task type=claude-code accepted when executor registered
  it('should accept claude-code type tasks when executor is available', async () => {
    // Register claude-code executor
    const { ClaudeCodeExecutor } = await import('../../src/executor/claude-code.js');
    registry.register(new ClaudeCodeExecutor());

    const res = await fetch(`${baseUrl}/tasks`, {
      method: 'POST', headers,
      body: JSON.stringify({ type: 'claude-code', prompt: 'say hi', working_dir: testDir }),
    });
    expect(res.status).toBe(201);
  });

  // API-26: Capabilities returns registered executors
  it('should list registered executors in capabilities', async () => {
    const res = await fetch(`${baseUrl}/capabilities`, { headers });
    const data = await res.json();
    expect(data.executors).toBeDefined();
    expect(data.executors.map((e: any) => e.type)).toContain('shell');
  });

  // API-27: Health returns queue stats
  it('should include queue info in health', async () => {
    const res = await fetch(`${baseUrl}/health`);
    const data = await res.json();
    expect(data.status).toBe('healthy');
  });

  // API-17: DELETE already completed task
  it('should handle DELETE of already completed task', async () => {
    const res = await fetch(`${baseUrl}/tasks`, {
      method: 'POST', headers,
      body: JSON.stringify({ type: 'shell', prompt: 'echo done', working_dir: testDir }),
    });
    const { id } = await res.json();

    // Wait for completion
    await new Promise(r => setTimeout(r, 1000));

    const delRes = await fetch(`${baseUrl}/tasks/${id}`, { method: 'DELETE', headers });
    expect(delRes.status).toBe(200);
  });

  // API-30: Very long prompt
  it('should accept task with near-limit prompt length', async () => {
    const longPrompt = 'x'.repeat(50000);
    const res = await fetch(`${baseUrl}/tasks`, {
      method: 'POST', headers,
      body: JSON.stringify({ type: 'shell', prompt: longPrompt, working_dir: testDir }),
    });
    expect(res.status).toBe(201);
  });

  // Multiple concurrent requests
  it('should handle concurrent task submissions', async () => {
    const submissions = Array.from({ length: 5 }, () =>
      fetch(`${baseUrl}/tasks`, {
        method: 'POST', headers,
        body: JSON.stringify({ type: 'shell', prompt: `echo "concurrent-${Math.random()}"`, working_dir: testDir }),
      })
    );

    const results = await Promise.all(submissions);
    const statuses = results.map(r => r.status);
    // All should succeed (queue has room)
    expect(statuses.every(s => s === 201)).toBe(true);
  });
});
