import { describe, it, expect } from 'vitest';
import { Config, IsolationMode, ExecutorType, TaskStatus, Task } from '../../src/config/schema.js';

describe('Config Schema', () => {
  describe('IsolationMode', () => {
    it('should validate valid isolation modes', () => {
      expect(IsolationMode.safeParse('docker').success).toBe(true);
      expect(IsolationMode.safeParse('host').success).toBe(true);
      expect(IsolationMode.safeParse('worktree').success).toBe(true);
    });

    it('should reject invalid isolation modes', () => {
      expect(IsolationMode.safeParse('invalid').success).toBe(false);
      expect(IsolationMode.safeParse('vm').success).toBe(false);
    });
  });

  describe('ExecutorType', () => {
    it('should validate valid executor types', () => {
      expect(ExecutorType.safeParse('shell').success).toBe(true);
      expect(ExecutorType.safeParse('claude-code').success).toBe(true);
    });

    it('should reject invalid executor types', () => {
      expect(ExecutorType.safeParse('python').success).toBe(false);
      expect(ExecutorType.safeParse('node').success).toBe(false);
    });
  });

  describe('Task', () => {
    const validTask = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      type: 'shell' as const,
      prompt: 'echo "hello"',
      working_dir: '/tmp',
      isolation: 'host' as const,
      timeout_ms: 30000,
      env: { TEST: 'value' },
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
      started_at: null,
      completed_at: null,
      exit_code: null,
      error: null,
      output_path: null,
      cost_usd: 0,
    };

    it('should validate a valid task', () => {
      const result = Task.safeParse(validTask);
      expect(result.success).toBe(true);
    });

    it('should require valid UUID for id', () => {
      const invalidTask = { ...validTask, id: 'not-a-uuid' };
      const result = Task.safeParse(invalidTask);
      expect(result.success).toBe(false);
    });

    it('should enforce timeout_ms min/max', () => {
      const tooShort = { ...validTask, timeout_ms: 500 };
      expect(Task.safeParse(tooShort).success).toBe(false);

      const tooLong = { ...validTask, timeout_ms: 4000000 };
      expect(Task.safeParse(tooLong).success).toBe(false);
    });

    it('should enforce max_iterations range', () => {
      const tooLow = { ...validTask, max_iterations: 0 };
      expect(Task.safeParse(tooLow).success).toBe(false);

      const tooHigh = { ...validTask, max_iterations: 25 };
      expect(Task.safeParse(tooHigh).success).toBe(false);
    });

    it('should enforce max_budget_usd range', () => {
      const tooLow = { ...validTask, max_budget_usd: 0.005 };
      expect(Task.safeParse(tooLow).success).toBe(false);

      const tooHigh = { ...validTask, max_budget_usd: 200.0 };
      expect(Task.safeParse(tooHigh).success).toBe(false);
    });

    it('should apply defaults for optional fields', () => {
      const minimalTask = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'shell' as const,
        prompt: 'echo "hello"',
        working_dir: '/tmp',
        isolation: 'host' as const,
        status: 'pending' as const,
        created_at: new Date().toISOString(),
      };

      const result = Task.parse(minimalTask);
      expect(result.timeout_ms).toBe(300000); // default
      expect(result.allow_network).toBe(false); // default
    });
  });

  describe('Config', () => {
    const validConfig = {
      execution: {
        default_isolation: 'host' as const,
        allow_host: true,
        allow_worktree: false,
        max_concurrent: 1,
        max_queue_size: 100,
        default_timeout_ms: 300000,
        max_timeout_ms: 3600000,
      },
      backup: {
        enabled: true,
        provider: 's3' as const,
        endpoint: 'https://s3.example.com',
        bucket: 'test-bucket',
        region: 'us-east-1',
        log_interval_ms: 300000,
        full_interval_hours: 24,
        retention_days: 30,
      },
    };

    it('should validate a valid config', () => {
      const result = Config.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    it('should apply defaults for optional config sections', () => {
      const minimalConfig = {
        execution: validConfig.execution,
        backup: validConfig.backup,
      };

      const result = Config.safeParse(minimalConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.server.port).toBe(8080); // default
        expect(result.data.execution.max_concurrent).toBe(1);
        expect(result.data.judge.enabled).toBe(false); // default
      }
    });

    it('should require execution config', () => {
      const invalidConfig = {
        backup: validConfig.backup,
      };

      const result = Config.safeParse(invalidConfig);
      expect(result.success).toBe(false);
    });

    it('should require backup config', () => {
      const invalidConfig = {
        execution: validConfig.execution,
      };

      const result = Config.safeParse(invalidConfig);
      expect(result.success).toBe(false);
    });
  });
});
