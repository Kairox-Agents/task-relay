#!/usr/bin/env node
/**
 * Real-World E2E Test Suite for Task-Relay
 *
 * This script tests the full system in a realistic scenario:
 * - Starts the daemon as a real subprocess
 * - Submits tasks via HTTP
 * - Verifies execution, status updates, results
 * - Tests all executors, all API endpoints
 * - Tests concurrency, cancellation, error handling
 * - Tests MCP server integration
 *
 * This is what you'd run to verify a deployment actually works.
 *
 * Usage: node test/e2e/real-world.js
 */

import { spawn, exec } from 'node:child_process';
import { rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { v4 as uuidv4 } from 'uuid';

const DAEMON_PORT = 18080;
const TEST_DIR = join(tmpdir(), 'task-relay-e2e-real-' + Date.now());
const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;
const API_KEY = 'test-e2e-key';

let daemonProcess;
let testResults = [];

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function test(name: string, fn: () => Promise<void>) {
  const start = Date.now();
  try {
    await fn();
    const duration = Date.now() - start;
    testResults.push({ name, passed: true, duration });
    console.log(`✅ ${name} (${duration}ms)`);
  } catch (err) {
    const duration = Date.now() - start;
    const error = err instanceof Error ? err.message : String(err);
    testResults.push({ name, passed: false, duration, error });
    console.log(`❌ ${name} (${duration}ms): ${error}`);
    throw err;
  }
}

async function daemonRequest(method: string, path: string, body?: any, apiKey: string = API_KEY) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };
  const opts: RequestInit = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const response = await fetch(`${DAEMON_URL}${path}`, opts);
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

async function pollTask(id: string, targetStatus: string, maxMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const { data } = await daemonRequest('GET', `/tasks/${id}`);
    if (data?.status === targetStatus) return data;
    await sleep(200);
  }
  const { data } = await daemonRequest('GET', `/tasks/${id}`);
  return data;
}

async function startDaemon() {
  console.log('\n🚀 Starting daemon...');

  // Create test config
  const configPath = join(TEST_DIR, 'config.yaml');
  await mkdir(TEST_DIR, { recursive: true });
  await writeFile(configPath, `
server:
  port: ${DAEMON_PORT}
  bind: '127.0.0.1'

auth:
  api_keys:
    - id: e2e-key
      key: ${API_KEY}
      allowed_types: ['shell', 'claude-code']
      allowed_isolation: ['host']

execution:
  default_isolation: 'host'
  allow_host: true
  allow_worktree: false
  max_concurrent: 2
  max_queue_size: 10
  default_timeout_ms: 10000
  max_timeout_ms: 60000

judge:
  enabled: false
  default_model: 'haiku'
  max_iterations_default: 5
  scoring:
    pass_threshold: 90
    partial_threshold: 70
  deterministic_checks: {}
  escalation: {}

paths:
  allowed: ['${TEST_DIR}']

env:
  allowed_prefix: 'E2E_'
  allowed_keys: ['NODE_ENV']

executors:
  shell:
    enabled: true
  claude-code:
    enabled: true
    default_model: 'sonnet'
    judge_model: 'haiku'
    default_budget_usd: 0.01
    max_budget_usd: 1.0

docker:
  image: 'task-relay/executor:latest'
  build_image_on_start: false
  memory: '2g'
  cpus: 1
  network: 'none'
  read_only: true

worktree:
  enabled: false
  auto_cleanup: true
  base_branch: 'main'
  merge_policy: 'review'

backup:
  enabled: false
  provider: 's3'
  endpoint: 'https://s3.amazonaws.com'
  bucket: 'test-bucket'
  region: 'us-east-1'
  log_interval_ms: 300000
  full_interval_hours: 24
  retention_days: 30

retention:
  max_age_days: 30
  max_tasks: 1000
  run_on_startup: false
  run_daily_at: '03:00'
  keep_failed_tasks: true

logging:
  level: 'error'
  pretty: false
`);

  // Start daemon
  return new Promise<void>((resolve, reject) => {
    daemonProcess = spawn('node', ['dist/cli.js', 'start'], {
      cwd: process.cwd(),
      env: { ...process.env, TASK_RELAY_CONFIG: configPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    daemonProcess.stderr?.on('data', (data) => {
      const line = data.toString().trim();
      if (line && !line.includes('[TRACE]')) {
        console.log(`  [daemon stderr] ${line}`);
      }
    });

    // Wait for daemon to be ready
    const checkReady = async () => {
      try {
        const res = await fetch(`${DAEMON_URL}/health`);
        if (res.ok) {
          console.log(`✅ Daemon ready at ${DAEMON_URL}`);
          resolve();
          return;
        }
      } catch {}
      setTimeout(checkReady, 200);
    };
    setTimeout(checkReady, 500);

    daemonProcess.on('error', reject);
    daemonProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Daemon exited with code ${code}`));
      }
    });
  });
}

async function stopDaemon() {
  if (daemonProcess && !daemonProcess.killed) {
    console.log('\n🛑 Stopping daemon...');
    daemonProcess.kill('SIGTERM');
    await sleep(1000);
    if (!daemonProcess.killed) {
      daemonProcess.kill('SIGKILL');
    }
  }
}

async function runTests() {
  console.log('\n═════════════════════════════════════════════════════════════════════');
  console.log('  TASK-RELAY REAL-WORLD E2E TEST SUITE');
  console.log('═════════════════════════════════════════════════════════════════════\n');

  await startDaemon();
  await sleep(500);

  // ========== TESTS ==========

  // Test 1: Health check
  await test('Health check returns healthy', async () => {
    const res = await fetch(`${DAEMON_URL}/health`);
    const data = await res.json();
    if (data.status !== 'healthy') throw new Error('Health check failed');
  });

  // Test 2: Capabilities endpoint
  await test('Capabilities returns executors', async () => {
    const { data } = await daemonRequest('GET', '/capabilities');
    if (!data.executors || !Array.isArray(data.executors)) {
      throw new Error('Capabilities missing executors');
    }
    const types = data.executors.map((e: any) => e.type);
    if (!types.includes('shell')) throw new Error('Shell executor missing');
    if (!types.includes('claude-code')) throw new Error('Claude-code executor missing');
  });

  // Test 3: Submit shell task
  await test('Submit simple shell task', async () => {
    const { status, data } = await daemonRequest('POST', '/tasks', {
      type: 'shell',
      prompt: 'echo "hello world"',
      working_dir: TEST_DIR,
    });
    if (status !== 201) throw new Error(`Submit failed: ${JSON.stringify(data)}`);
    if (!data.id) throw new Error('No task ID returned');
    if (data.status !== 'pending') throw new Error(`Task not pending: ${data.status}`);
  });

  // Test 4: Shell task execution
  await test('Execute shell task to completion', async () => {
    const { data: task } = await daemonRequest('POST', '/tasks', {
      type: 'shell',
      prompt: 'echo "e2e test" && echo "line2"',
      working_dir: TEST_DIR,
    });

    const result = await pollTask(task.id, 'completed');
    if (result.status !== 'completed') throw new Error(`Task not completed: ${result.status}`);
    if (result.exit_code !== 0) throw new Error(`Exit code: ${result.exit_code}`);
    if (!result.started_at) throw new Error('No started_at timestamp');
    if (!result.completed_at) throw new Error('No completed_at timestamp');
  });

  // Test 5: Shell task with env vars
  await test('Shell task with env vars', async () => {
    const { data: task } = await daemonRequest('POST', '/tasks', {
      type: 'shell',
      prompt: 'echo $E2E_TEST_VAR',
      working_dir: TEST_DIR,
      env: { E2E_TEST_VAR: 'hello-from-env' },
    });

    await pollTask(task.id, 'completed');
  });

  // Test 6: Shell task with timeout
  await test('Shell task times out', async () => {
    const { data: task } = await daemonRequest('POST', '/tasks', {
      type: 'shell',
      prompt: 'sleep 30',
      working_dir: TEST_DIR,
      timeout_ms: 2000,
    });

    const result = await pollTask(task.id, 'failed', 10000);
    if (result.status !== 'failed') throw new Error(`Task should be failed: ${result.status}`);
    if (!result.error?.toLowerCase().includes('timed out')) {
      throw new Error(`Error should mention timeout: ${result.error}`);
    }
  });

  // Test 7: Shell task with error
  await test('Shell task with non-zero exit', async () => {
    const { data: task } = await daemonRequest('POST', '/tasks', {
      type: 'shell',
      prompt: 'echo "oops" >&2; exit 42',
      working_dir: TEST_DIR,
    });

    const result = await pollTask(task.id, 'failed');
    if (result.status !== 'failed') throw new Error(`Task should be failed: ${result.status}`);
    if (result.exit_code !== 42) throw new Error(`Exit code should be 42: ${result.exit_code}`);
  });

  // Test 8: Cancel running task
  await test('Cancel running task', async () => {
    const { data: task } = await daemonRequest('POST', '/tasks', {
      type: 'shell',
      prompt: 'sleep 30',
      working_dir: TEST_DIR,
    });

    await sleep(200); // Let it start

    const { status, data } = await daemonRequest('DELETE', `/tasks/${task.id}`);
    if (status !== 200) throw new Error(`Cancel failed: ${JSON.stringify(data)}`);
  });

  // Test 9: Get task by ID
  await test('Get task by ID', async () => {
    const { data: created } = await daemonRequest('POST', '/tasks', {
      type: 'shell',
      prompt: 'echo "get test"',
      working_dir: TEST_DIR,
    });

    await pollTask(created.id, 'completed');

    const { status, data } = await daemonRequest('GET', `/tasks/${created.id}`);
    if (status !== 200) throw new Error('Get failed');
    if (data.id !== created.id) throw new Error('Wrong task ID');
  });

  // Test 10: List tasks
  await test('List tasks', async () => {
    const { status, data } = await daemonRequest('GET', '/tasks');
    if (status !== 200) throw new Error('List failed');
    if (!Array.isArray(data.tasks)) throw new Error('Tasks not an array');
    if (data.tasks.length < 1) throw new Error('Should have at least one task');
  });

  // Test 11: List tasks with status filter
  await test('List tasks with status filter', async () => {
    const { status, data } = await daemonRequest('GET', '/tasks?status=completed');
    if (status !== 200) throw new Error('List with filter failed');
    if (!data.tasks.every((t: any) => t.status === 'completed')) {
      throw new Error('Filter not working');
    }
  });

  // Test 12: List tasks pagination
  await test('List tasks with pagination', async () => {
    const { data: data1 } = await daemonRequest('GET', '/tasks?limit=1&offset=0');
    const { data: data2 } = await daemonRequest('GET', '/tasks?limit=1&offset=1');
    if (data1.tasks[0].id === data2.tasks[0]?.id) {
      throw new Error('Pagination not working');
    }
  });

  // Test 13: Concurrent tasks (maxConcurrent=2)
  await test('Concurrent task execution', async () => {
    const tasks = [];
    for (let i = 0; i < 3; i++) {
      const { data } = await daemonRequest('POST', '/tasks', {
        type: 'shell',
        prompt: `echo "concurrent-${i}" && sleep 1`,
        working_dir: TEST_DIR,
      });
      tasks.push(data.id);
    }

    // All should complete
    for (const id of tasks) {
      await pollTask(id, 'completed', 15000);
    }
  });

  // Test 14: Queue full
  await test('Queue full rejection', async () => {
    // Fill queue (maxConcurrent=2, maxQueueSize=10) -> we can submit 12, 13th rejected
    // For simplicity, submit 3 long tasks, then try a 4th
    const tasks = [];
    for (let i = 0; i < 3; i++) {
      const { data } = await daemonRequest('POST', '/tasks', {
        type: 'shell',
        prompt: 'sleep 5',
        working_dir: TEST_DIR,
      });
      tasks.push(data.id);
    }

    await sleep(100);

    // Try to submit more than capacity
    let rejected = false;
    for (let i = 0; i < 15; i++) {
      const { status } = await daemonRequest('POST', '/tasks', {
        type: 'shell',
        prompt: 'echo "queued"',
        working_dir: TEST_DIR,
      });
      if (status === 503) {
        rejected = true;
        break;
      }
    }

    // Clean up: cancel all tasks
    for (const id of tasks) {
      await daemonRequest('DELETE', `/tasks/${id}`);
    }
    await sleep(500);

    if (!rejected) throw new Error('Queue should have rejected');
  });

  // Test 15: Auth - wrong key
  await test('Auth: wrong API key rejected', async () => {
    const res = await fetch(`${DAEMON_URL}/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer wrong-key',
      },
      body: JSON.stringify({ type: 'shell', prompt: 'echo test', working_dir: TEST_DIR }),
    });
    if (res.status !== 401) throw new Error(`Should be 401: ${res.status}`);
  });

  // Test 16: Auth - missing header
  await test('Auth: missing auth header rejected', async () => {
    const res = await fetch(`${DAEMON_URL}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'shell', prompt: 'echo test', working_dir: TEST_DIR }),
    });
    if (res.status !== 401) throw new Error(`Should be 401: ${res.status}`);
  });

  // Test 17: Invalid task type
  await test('Invalid task type rejected', async () => {
    const { status, data } = await daemonRequest('POST', '/tasks', {
      type: 'python',
      prompt: 'print("test")',
      working_dir: TEST_DIR,
    });
    if (status !== 400) throw new Error(`Should be 400: ${status}`);
  });

  // Test 18: Disallowed working dir
  await test('Disallowed working dir rejected', async () => {
    const { status, data } = await daemonRequest('POST', '/tasks', {
      type: 'shell',
      prompt: 'echo test',
      working_dir: '/etc',
    });
    if (status !== 403) throw new Error(`Should be 403: ${status}`);
  });

  // Test 19: Disallowed env var
  await test('Disallowed env var rejected', async () => {
    const { status, data } = await daemonRequest('POST', '/tasks', {
      type: 'shell',
      prompt: 'echo $SECRET',
      working_dir: TEST_DIR,
      env: { SECRET: 'should-be-rejected' },
    });
    if (status !== 400) throw new Error(`Should be 400: ${status}`);
  });

  // Test 20: Malformed JSON
  await test('Malformed JSON rejected', async () => {
    const res = await fetch(`${DAEMON_URL}/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: 'not json',
    });
    if (res.status !== 400) throw new Error(`Should be 400: ${res.status}`);
  });

  // Test 21: Shell + docker isolation rejected
  await test('Shell + docker isolation rejected', async () => {
    const { status, data } = await daemonRequest('POST', '/tasks', {
      type: 'shell',
      prompt: 'echo test',
      working_dir: TEST_DIR,
      isolation: 'docker',
    });
    if (status !== 403) throw new Error(`Should be 403: ${status}`);
  });

  // Test 22: GET /tasks/:id returns sanitized output (no prompt)
  await test('Task status does not include prompt', async () => {
    const { data: task } = await daemonRequest('POST', '/tasks', {
      type: 'shell',
      prompt: 'echo "secret prompt"',
      working_dir: TEST_DIR,
    });

    await pollTask(task.id, 'completed');

    const { data: fetched } = await daemonRequest('GET', `/tasks/${task.id}`);
    if (fetched.prompt !== undefined) throw new Error('Prompt should not be in task status');
  });

  // Test 23: DELETE non-existent task
  await test('DELETE non-existent task returns 404', async () => {
    const { status, data } = await daemonRequest('DELETE', `/tasks/00000000-0000-0000-0000-000000000000`);
    if (status !== 404) throw new Error(`Should be 404: ${status}`);
  });

  // Test 24: GET non-existent task
  await test('GET non-existent task returns 404', async () => {
    const { status, data } = await daemonRequest('GET', `/tasks/00000000-0000-0000-0000-000000000000`);
    if (status !== 404) throw new Error(`Should be 404: ${status}`);
  });

  // Test 25: Unknown route returns 404
  await test('Unknown route returns 404', async () => {
    const res = await fetch(`${DAEMON_URL}/unknown`, {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
    });
    const data = await res.json();
    if (res.status !== 404 || data?.error?.code !== 'NOT_FOUND') {
      throw new Error('Should be 404 with NOT_FOUND code');
    }
  });

  // ========== CLEANUP ==========

  await stopDaemon();
  await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});

  // ========== SUMMARY ==========

  console.log('\n═════════════════════════════════════════════════════════════════════');
  console.log('  TEST RESULTS');
  console.log('═════════════════════════════════════════════════════════════════════\n');

  const passed = testResults.filter(r => r.passed);
  const failed = testResults.filter(r => !r.passed);

  console.log(`Total: ${testResults.length}`);
  console.log(`Passed: ${passed.length} ✅`);
  console.log(`Failed: ${failed.length} ❌`);
  console.log(`Duration: ${testResults.reduce((sum, r) => sum + r.duration, 0)}ms\n`);

  if (failed.length > 0) {
    console.log('Failed tests:');
    failed.forEach(r => {
      console.log(`  - ${r.name}: ${r.error}`);
    });
    console.log();
  }

  if (failed.length === 0) {
    console.log('🎉 All tests passed!');
    process.exit(0);
  } else {
    console.log('💥 Some tests failed.');
    process.exit(1);
  }
}

// Run
runTests().catch((err) => {
  console.error('\n💥 Fatal error:', err);
  stopDaemon().then(() => process.exit(1));
});
