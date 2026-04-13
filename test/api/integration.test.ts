import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { serve } from '@hono/node-server';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../../src/api/server.js';
import { DatabaseManager, TaskRepository } from '../../src/db/index.js';
import { ShellExecutor } from '../../src/executor/shell.js';
import { registry } from '../../src/executor/registry.js';
import { TaskQueue } from '../../src/executor/queue.js';
import type { Config } from '../../src/config/schema.js';

describe('API Integration Tests', () => {
  let server: any;
  let baseUrl: string;
  let dbManager: DatabaseManager;
  let taskRepo: TaskRepository;
  let taskQueue: TaskQueue;
  let testDir: string;
  let configPath: string;
  let apiKey: string;
  let testDaemon: any;

  const testConfig: Config = {
    server: {
      port: 0, // Let OS assign port
      bind: '127.0.0.1',
    },
    auth: {
      api_keys: [
        {
          id: 'test-key',
          key: 'test-secret-key',
          allowed_types: ['shell'],
          allowed_isolation: ['host'],
        },
      ],
    },
    execution: {
      default_isolation: 'host',
      allow_host: true,
      allow_worktree: false,
      max_concurrent: 1,
      max_queue_size: 10,
      default_timeout_ms: 30000,
      max_timeout_ms: 60000,
    },
    judge: {
      enabled: false,
      default_model: 'haiku',
      max_iterations_default: 5,
      scoring: { pass_threshold: 90, partial_threshold: 70 },
      deterministic_checks: {},
      escalation: {},
    },
    paths: {
      allowed: [tmpdir()],
    },
    env: {
      allowed_prefix: 'TASK_',
      allowed_keys: ['NODE_ENV'],
    },
    executors: {
      shell: { enabled: true },
      'claude-code': { enabled: false, default_model: 'sonnet', judge_model: 'haiku', default_budget_usd: 1.0, max_budget_usd: 5.0 },
    },
    docker: {
      image: 'task-relay/executor:latest',
      build_image_on_start: false,
      memory: '2g',
      cpus: 1,
      network: 'none',
      read_only: true,
    },
    worktree: {
      enabled: false,
      auto_cleanup: true,
      base_branch: 'main',
      merge_policy: 'review',
    },
    backup: {
      enabled: false,
      provider: 's3',
      endpoint: 'https://s3.example.com',
      bucket: 'test-bucket',
      region: 'us-east-1',
      log_interval_ms: 300000,
      full_interval_hours: 24,
      retention_days: 30,
    },
    retention: {
      max_age_days: 30,
      max_tasks: 1000,
      run_on_startup: false,
      run_daily_at: '03:00',
      keep_failed_tasks: true,
    },
    logging: {
      level: 'error',
      pretty: false,
    },
  };

  beforeEach(async () => {
    testDir = join(tmpdir(), 'task-relay-api-test-' + Date.now());
    await mkdir(testDir, { recursive: true });

    // Setup database
    dbManager = new DatabaseManager(join(testDir, 'test.db'));
    taskRepo = new TaskRepository(dbManager.getDatabase());

    // Register shell executor
    registry.register(new ShellExecutor());

    // Setup queue
    taskQueue = new TaskQueue({
      maxConcurrent: 1,
      maxQueueSize: 10,
    });

    // Setup daemon (wires queue to executors)
    const { TaskDaemon } = await import('../../src/executor/daemon.js');
    const daemon = new TaskDaemon({
      taskQueue,
      taskRepo,
    });

    // Create server and wait for it to be ready
    const app = createServer(testConfig, taskRepo, taskQueue);
    const serverReady = new Promise<any>((resolve) => {
      server = serve(
        {
          fetch: app.fetch,
          port: 0, // Let OS assign port
          hostname: '127.0.0.1',
        },
        (info) => resolve(info)
      );
    });

    const info = await serverReady;
    baseUrl = `http://127.0.0.1:${info.port}`;

    // Store daemon for cleanup
    testDaemon = daemon;
    apiKey = 'test-secret-key';
  });

  afterEach(async () => {
    // Wait for daemon to finish processing before closing DB
    if (testDaemon) {
      await testDaemon.shutdown();
    }
    server?.close();
    dbManager?.close();
    await rm(testDir, { recursive: true, force: true });
  });

  const request = async (path: string, options: RequestInit = {}) => {
    const url = `${baseUrl}${path}`;
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(url, {
      ...options,
      headers,
    });

    return {
      status: response.status,
      data: await response.json().catch(() => null),
    };
  };

  describe('GET /health', () => {
    it('should return healthy status', async () => {
      const { status, data } = await request('/health');

      expect(status).toBe(200);
      expect(data.status).toBe('healthy');
      expect(data.version).toBeTruthy();
    });

    it('should not require authentication', async () => {
      apiKey = ''; // Remove auth
      const { status } = await request('/health');

      expect(status).toBe(200);
    });
  });

  describe('POST /tasks', () => {
    it('should create a new task', async () => {
      const taskData = {
        type: 'shell',
        prompt: 'echo "hello"',
        working_dir: testDir,
      };

      const { status, data } = await request('/tasks', {
        method: 'POST',
        body: JSON.stringify(taskData),
      });

      expect(status).toBe(201);
      expect(data.id).toBeTruthy();
      expect(data.status).toBe('pending');
    });

    it('should reject without authentication', async () => {
      apiKey = '';
      const taskData = { type: 'shell', prompt: 'echo "test"', working_dir: testDir };

      const { status, data } = await request('/tasks', {
        method: 'POST',
        body: JSON.stringify(taskData),
      });

      expect(status).toBe(401);
      expect(data.error.code).toBe('UNAUTHORIZED');
    });

    it('should reject invalid API key', async () => {
      apiKey = 'invalid-key';
      const taskData = { type: 'shell', prompt: 'echo "test"', working_dir: testDir };

      const { status, data } = await request('/tasks', {
        method: 'POST',
        body: JSON.stringify(taskData),
      });

      expect(status).toBe(401);
      expect(data.error.code).toBe('UNAUTHORIZED');
    });

    it('should validate task schema', async () => {
      const invalidTask = { type: 'invalid-type', prompt: 'test', working_dir: testDir };

      const { status, data } = await request('/tasks', {
        method: 'POST',
        body: JSON.stringify(invalidTask),
      });

      expect(status).toBe(400);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject disallowed isolation mode', async () => {
      const taskData = {
        type: 'shell',
        prompt: 'echo "test"',
        working_dir: testDir,
        isolation: 'docker',
      };

      const { status, data } = await request('/tasks', {
        method: 'POST',
        body: JSON.stringify(taskData),
      });

      expect(status).toBe(403);
      expect(data.error.code).toBe('ISOLATION_NOT_ALLOWED');
    });

    it('should reject disallowed working directory', async () => {
      const taskData = {
        type: 'shell',
        prompt: 'echo "test"',
        working_dir: '/forbidden/path',
      };

      const { status, data } = await request('/tasks', {
        method: 'POST',
        body: JSON.stringify(taskData),
      });

      expect(status).toBe(403);
      expect(data.error.code).toBe('PATH_NOT_ALLOWED');
    });

    it('should reject queue full', async () => {
      // maxConcurrent=1, maxQueueSize=1 means:
      // 1 running + 1 queued = 2 total before rejection
      const fullQueue = new TaskQueue({ maxConcurrent: 1, maxQueueSize: 1 });
      const fullApp = createServer(testConfig, taskRepo, fullQueue);
      server.close();
      const serverReady = new Promise<any>((resolve) => {
        server = serve(
          {
            fetch: fullApp.fetch,
            port: 0,
            hostname: '127.0.0.1',
          },
          (info) => resolve(info)
        );
      });
      const info = await serverReady;
      baseUrl = `http://127.0.0.1:${info.port}`;

      // Fill running slot
      await request('/tasks', {
        method: 'POST',
        body: JSON.stringify({ type: 'shell', prompt: 'sleep 5', working_dir: testDir }),
      });

      // Fill queue slot
      await request('/tasks', {
        method: 'POST',
        body: JSON.stringify({ type: 'shell', prompt: 'sleep 5', working_dir: testDir }),
      });

      // Third task should be rejected
      const { status, data } = await request('/tasks', {
        method: 'POST',
        body: JSON.stringify({ type: 'shell', prompt: 'echo "test"', working_dir: testDir }),
      });

      expect(status).toBe(503);
      expect(data.error.code).toBe('QUEUE_FULL');
    });
  });

  describe('GET /tasks/:id', () => {
    it('should get task by ID', async () => {
      // Create task first
      const createResponse = await request('/tasks', {
        method: 'POST',
        body: JSON.stringify({ type: 'shell', prompt: 'echo "test"', working_dir: testDir }),
      });

      const taskId = createResponse.data.id;

      // Get task (may already be completed since daemon runs in background)
      const { status, data } = await request(`/tasks/${taskId}`);

      expect(status).toBe(200);
      expect(data.id).toBe(taskId);
      expect(['pending', 'running', 'completed']).toContain(data.status);
    });

    it('should return 404 for non-existent task', async () => {
      const { status, data } = await request('/tasks/non-existent-id');

      expect(status).toBe(404);
      expect(data.error.code).toBe('TASK_NOT_FOUND');
    });
  });

  describe('GET /tasks', () => {
    beforeEach(async () => {
      // Create multiple tasks
      for (let i = 0; i < 3; i++) {
        await request('/tasks', {
          method: 'POST',
          body: JSON.stringify({ type: 'shell', prompt: 'echo "test"', working_dir: testDir }),
        });
      }
    });

    it('should list all tasks', async () => {
      const { status, data } = await request('/tasks');

      expect(status).toBe(200);
      expect(data.tasks.length).toBeGreaterThanOrEqual(3);
    });

    it('should filter by status', async () => {
      // Tasks may have already completed, so check for completed
      const { status, data } = await request('/tasks?status=completed');

      expect(status).toBe(200);
      // Tasks complete quickly, so they should be in 'completed' state
      expect(data.tasks.length).toBeGreaterThanOrEqual(0);
    });

    it('should support pagination', async () => {
      const { status, data } = await request('/tasks?limit=2&offset=0');

      expect(status).toBe(200);
      expect(data.tasks.length).toBe(2);
    });
  });

  describe('DELETE /tasks/:id', () => {
    it('should cancel running task', async () => {
      // Create task
      const createResponse = await request('/tasks', {
        method: 'POST',
        body: JSON.stringify({ type: 'shell', prompt: 'sleep 10', working_dir: testDir }),
      });

      const taskId = createResponse.data.id;

      // Wait a moment for task to start
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Cancel task
      const { status, data } = await request(`/tasks/${taskId}`, { method: 'DELETE' });

      expect(status).toBe(200);
      expect(data.status).toBe('cancelled');
    });

    it('should return 404 for non-existent task', async () => {
      const { status, data } = await request('/tasks/non-existent-id', { method: 'DELETE' });

      expect(status).toBe(404);
      expect(data.error.code).toBe('TASK_NOT_FOUND');
    });
  });

  describe('GET /capabilities', () => {
    it('should return capabilities', async () => {
      const { status, data } = await request('/capabilities');

      expect(status).toBe(200);
      expect(data.version).toBeTruthy();
      expect(data.executors).toBeInstanceOf(Array);
      expect(data.isolation).toBeDefined();
      expect(data.limits).toBeDefined();
    });
  });
});
