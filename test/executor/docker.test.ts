import { describe, it, expect } from 'vitest';
import { buildDockerArgs, runInDocker } from '../../src/executor/docker.js';

describe('Docker runner', () => {
  it('should build docker run args correctly', () => {
    const args = buildDockerArgs({
      image: 'task-relay/executor:latest',
      workingDir: '/tmp/project',
      timeoutMs: 1000,
      outputPath: '/tmp/output.log',
      readOnly: true,
      network: 'none',
      memory: '2g',
      cpus: 1,
      env: { ANTHROPIC_API_KEY: 'test-key', FOO: 'bar' },
      command: ['claude', '-p', 'hello'],
    });

    expect(args).toContain('run');
    expect(args).toContain('--rm');
    expect(args).toContain('--network');
    expect(args).toContain('none');
    expect(args).toContain('--memory');
    expect(args).toContain('2g');
    expect(args).toContain('--cpus');
    expect(args).toContain('1');
    expect(args).toContain('--read-only');
    expect(args).toContain('-v');
    expect(args).toContain('/tmp/project:/workspace');
    expect(args).toContain('-w');
    expect(args).toContain('/workspace');
    expect(args).toContain('task-relay/executor:latest');
    expect(args.slice(-3)).toEqual(['claude', '-p', 'hello']);
  });

  it('should fail gracefully when docker is not available', async () => {
    const run = runInDocker({
      image: 'task-relay/executor:latest',
      workingDir: '/tmp',
      timeoutMs: 1000,
      outputPath: '/tmp/task-relay-docker-test.log',
      command: ['echo', 'hello'],
    });

    const result = await run.wait();

    expect(result.exitCode).toBeNull();
    expect(result.error).toBeTruthy();
  }, 10000);
});
