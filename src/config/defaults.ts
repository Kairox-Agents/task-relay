import type { Config } from './schema.js';

export const DEFAULT_CONFIG: Config = {
  server: {
    port: 8080,
    bind: '0.0.0.0',
  },
  auth: {
    api_keys: [],
  },
  execution: {
    default_isolation: 'docker',
    allow_host: true,
    allow_worktree: false,
    max_concurrent: 1,
    max_queue_size: 100,
    default_timeout_ms: 300000,
    max_timeout_ms: 3600000,
  },
  judge: {
    enabled: false,
    default_model: 'haiku',
    max_iterations_default: 5,
    scoring: {
      pass_threshold: 90,
      partial_threshold: 70,
    },
    deterministic_checks: {
      test_command: null,
      lint_command: null,
      typecheck_command: null,
    },
    escalation: {
      max_iterations: 5,
      detect_loops: true,
      detect_declining: true,
    },
  },
  paths: {
    allowed: [],
  },
  env: {
    allowed_prefix: 'TASK_',
    allowed_keys: ['NODE_ENV', 'GIT_BRANCH'],
  },
  executors: {
    shell: {
      enabled: true,
    },
    'claude-code': {
      enabled: true,
      default_model: 'sonnet',
      judge_model: 'haiku',
      default_budget_usd: 1.0,
      max_budget_usd: 5.0,
    },
  },
  docker: {
    image: 'task-relay/executor:latest',
    build_image_on_start: true,
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
    enabled: true,
    provider: 's3',
    endpoint: 'https://s3.us-west-004.backblazeb2.com',
    bucket: 'task-relay-backups',
    region: 'us-west-004',
    log_interval_ms: 300000,
    full_interval_hours: 24,
    retention_days: 30,
  },
  retention: {
    max_age_days: 90,
    max_tasks: 10000,
    run_on_startup: true,
    run_daily_at: '03:00',
    keep_failed_tasks: true,
  },
  logging: {
    level: 'info',
    pretty: false,
  },
};
