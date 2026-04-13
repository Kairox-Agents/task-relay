import { describe, it, expect, beforeEach } from 'vitest';
import { ClaudeCodeExecutor } from '../../src/executor/claude-code.js';

describe('ClaudeCodeExecutor', () => {
  let executor: ClaudeCodeExecutor;

  beforeEach(() => {
    executor = new ClaudeCodeExecutor();
  });

  describe('getType', () => {
    it('should return "claude-code"', () => {
      expect(executor.getType()).toBe('claude-code');
    });
  });

  describe('canHandle', () => {
    it('should handle claude-code tasks', () => {
      expect(executor.canHandle('claude-code')).toBe(true);
    });

    it('should not handle other task types', () => {
      expect(executor.canHandle('shell')).toBe(false);
      expect(executor.canHandle('python')).toBe(false);
    });
  });

  describe('execute', () => {
    it('should return an executor handle with cancel and wait', async () => {
      const task = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'claude-code' as const,
        prompt: 'echo hello',
        working_dir: '/tmp',
        isolation: 'host' as const,
        timeout_ms: 5000,
        env: {},
        allow_network: false,
        model: 'sonnet',
        max_budget_usd: 1.0,
        acceptance_criteria: null,
        max_iterations: 5,
        judge_model: null,
        current_iteration: 1,
        judge_history: [],
        judge_result: null,
        status: 'pending' as const,
        created_at: new Date().toISOString(),
      };

      const handle = executor.execute({
        task,
        workingDir: '/tmp',
        isolation: 'host',
        timeoutMs: 5000,
        env: {},
      });

      expect(handle).toHaveProperty('cancel');
      expect(handle).toHaveProperty('wait');
      expect(typeof handle.cancel).toBe('function');
      expect(typeof handle.wait).toBe('function');

      // Cancel immediately to prevent the SDK from trying to connect
      handle.cancel();

      // Wait should resolve (not hang) even after cancel
      const result = await handle.wait();
      expect(result).toHaveProperty('exitCode');
      expect(result).toHaveProperty('output');
      expect(result).toHaveProperty('error');
      expect(result).toHaveProperty('costUsd');
    });

    it('should report error when no ANTHROPIC_API_KEY and no claude login', async () => {
      const task = {
        id: '550e8400-e29b-41d4-a716-446655440001',
        type: 'claude-code' as const,
        prompt: 'say hi',
        working_dir: '/tmp',
        isolation: 'host' as const,
        timeout_ms: 15000,
        env: {},
        allow_network: false,
        model: 'sonnet',
        max_budget_usd: 1.0,
        acceptance_criteria: null,
        max_iterations: 5,
        judge_model: null,
        current_iteration: 1,
        judge_history: [],
        judge_result: null,
        status: 'pending' as const,
        created_at: new Date().toISOString(),
      };

      const handle = executor.execute({
        task,
        workingDir: '/tmp',
        isolation: 'host',
        timeoutMs: 15000,
        env: {},
      });

      const result = await handle.wait();

      // Should fail gracefully (no API key, no claude login, no CLI)
      expect(result.error).toBeTruthy();
      expect(result.costUsd).toBe(0);
    }, 20000);

    it('should handle cancel during execution', async () => {
      const task = {
        id: '550e8400-e29b-41d4-a716-446655440002',
        type: 'claude-code' as const,
        prompt: 'do something long',
        working_dir: '/tmp',
        isolation: 'host' as const,
        timeout_ms: 60000,
        env: {},
        allow_network: false,
        model: 'sonnet',
        max_budget_usd: 1.0,
        acceptance_criteria: null,
        max_iterations: 5,
        judge_model: null,
        current_iteration: 1,
        judge_history: [],
        judge_result: null,
        status: 'pending' as const,
        created_at: new Date().toISOString(),
      };

      const handle = executor.execute({
        task,
        workingDir: '/tmp',
        isolation: 'host',
        timeoutMs: 60000,
        env: {},
      });

      // Cancel after a short delay
      setTimeout(() => handle.cancel(), 500);

      const result = await handle.wait();
      // Result should exist regardless of success/failure
      expect(result).toHaveProperty('exitCode');
      expect(result).toHaveProperty('output');
      expect(result).toHaveProperty('error');
      expect(result).toHaveProperty('costUsd');
    }, 5000);

    it('should route docker isolation through docker runner and fail gracefully without docker', async () => {
      const task = {
        id: '550e8400-e29b-41d4-a716-446655440003',
        type: 'claude-code' as const,
        prompt: 'say hi from docker',
        working_dir: '/tmp',
        isolation: 'docker' as const,
        timeout_ms: 5000,
        env: {},
        allow_network: false,
        model: 'sonnet',
        max_budget_usd: 1.0,
        acceptance_criteria: null,
        max_iterations: 5,
        judge_model: null,
        current_iteration: 1,
        judge_history: [],
        judge_result: null,
        status: 'pending' as const,
        created_at: new Date().toISOString(),
      };

      const handle = executor.execute({
        task,
        workingDir: '/tmp',
        isolation: 'docker',
        timeoutMs: 5000,
        env: {},
      });

      const result = await handle.wait();
      expect(result.error).toBeTruthy();
    }, 10000);
  });
});
