import { z } from 'zod';

// Core types
export const IsolationMode = z.enum(['docker', 'host', 'worktree']);
export type IsolationMode = z.infer<typeof IsolationMode>;

export const ExecutorType = z.enum(['shell', 'claude-code']);
export type ExecutorType = z.infer<typeof ExecutorType>;

export const TaskStatus = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'timeout',
  'cancelled',
  'archived',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const JudgeStatus = z.enum(['in_progress', 'passed', 'partial', 'failed', 'escalated']);
export type JudgeStatus = z.infer<typeof JudgeStatus>;

// Task-related types
export const JudgeIteration = z.object({
  iteration: z.number().min(1),
  status: JudgeStatus,
  overall_score: z.number().min(0).max(100),
  criteria_scores: z.record(
    z.object({
      score: z.number().min(0).max(100),
      status: z.enum(['done', 'partial', 'missing']),
      feedback: z.string(),
    })
  ),
  feedback: z.string(),
  escalated_at: z.string().datetime().nullable(),
});
export type JudgeIteration = z.infer<typeof JudgeIteration>;

export const JudgeResult = z.object({
  final_status: JudgeStatus,
  total_iterations: z.number().min(0),
  final_score: z.number().min(0).max(100),
  escalated_at: z.string().datetime().nullable(),
});
export type JudgeResult = z.infer<typeof JudgeResult>;

export const Task = z.object({
  id: z.string().uuid(),
  type: ExecutorType,
  prompt: z.string().min(1),
  working_dir: z.string().min(1),
  isolation: IsolationMode,

  // Execution options
  timeout_ms: z.number().min(1000).max(3600000).default(300000),
  env: z.record(z.string()).optional(),
  allow_network: z.boolean().default(false),

  // Claude Code specific
  model: z.string().default('sonnet'),
  max_budget_usd: z.number().min(0.01).max(100.0).default(1.0),

  // Judge loop (v1.1)
  acceptance_criteria: z.string().nullable().default(null),
  max_iterations: z.number().min(1).max(20).default(5),
  judge_model: z.string().nullable().default(null),
  current_iteration: z.number().default(1),
  judge_history: z.array(JudgeIteration).default([]),
  judge_result: JudgeResult.nullable(),

  // Status
  status: TaskStatus.default('pending'),
  created_at: z.string().datetime(),
  started_at: z.string().datetime().nullable(),
  completed_at: z.string().datetime().nullable(),

  // Results
  exit_code: z.number().int().nullable(),
  error: z.string().nullable(),
  output_path: z.string().nullable(),
  cost_usd: z.number().min(0).default(0),

  // Judge loop enforcement
  // If acceptance_criteria is null, max_iterations MUST be 1
  // If judge loop disabled, ignore acceptance_criteria and max_iterations must be 1
});
export type Task = z.infer<typeof Task>;

// Config schema
export const ServerConfig = z.object({
  port: z.number().min(1).max(65535).default(8080),
  bind: z.string().default('0.0.0.0'),
});

export const ApiKeyConfig = z.object({
  id: z.string(),
  key: z.string(),
  allowed_types: z.array(ExecutorType).optional(),
  allowed_isolation: z.array(IsolationMode).optional(),
});

export const AuthConfig = z.object({
  api_keys: z.array(ApiKeyConfig).default([]),
});

export const ExecutionConfig = z.object({
  default_isolation: IsolationMode,
  allow_host: z.boolean().default(true),
  allow_worktree: z.boolean().default(false),
  max_concurrent: z.number().min(1).default(1),
  max_queue_size: z.number().min(1).default(100),
  default_timeout_ms: z.number().min(1000).default(300000),
  max_timeout_ms: z.number().min(1000).default(3600000),
});

export const ScoringConfig = z.object({
  pass_threshold: z.number().min(0).max(100).default(90),
  partial_threshold: z.number().min(0).max(100).default(70),
});

export const DeterministicChecksConfig = z.object({
  test_command: z.string().nullable().default(null),
  lint_command: z.string().nullable().default(null),
  typecheck_command: z.string().nullable().default(null),
});

export const EscalationConfig = z.object({
  max_iterations: z.number().min(1).default(5),
  detect_loops: z.boolean().default(true),
  detect_declining: z.boolean().default(true),
});

export const JudgeConfig = z.object({
  enabled: z.boolean().default(false),
  default_model: z.string().default('haiku'),
  max_iterations_default: z.number().min(1).default(5),
  scoring: ScoringConfig.default({ pass_threshold: 90, partial_threshold: 70 }),
  deterministic_checks: DeterministicChecksConfig.default({}),
  escalation: EscalationConfig.default({}),
});

export const PathsConfig = z.object({
  allowed: z.array(z.string()).default([]),
});

export const EnvConfig = z.object({
  allowed_prefix: z.string().default('TASK_'),
  allowed_keys: z.array(z.string()).default([]),
});

export const ShellExecutorConfig = z.object({
  enabled: z.boolean().default(true),
});

export const ClaudeCodeExecutorConfig = z.object({
  enabled: z.boolean().default(true),
  default_model: z.string().default('sonnet'),
  judge_model: z.string().default('haiku'),
  default_budget_usd: z.number().min(0).default(1.0),
  max_budget_usd: z.number().min(0).default(5.0),
});

export const ExecutorsConfig = z.object({
  shell: ShellExecutorConfig.default({}),
  'claude-code': ClaudeCodeExecutorConfig.default({}),
});

export const DockerConfig = z.object({
  image: z.string().default('task-relay/executor:latest'),
  build_image_on_start: z.boolean().default(true),
  memory: z.string().default('2g'),
  cpus: z.number().min(0.1).default(1),
  network: z.enum(['none', 'bridge']).default('none'),
  read_only: z.boolean().default(true),
});

export const WorktreeConfig = z.object({
  enabled: z.boolean().default(false),
  auto_cleanup: z.boolean().default(true),
  base_branch: z.string().default('main'),
  merge_policy: z.enum(['auto', 'review']).default('review'),
});

export const BackupConfig = z.object({
  enabled: z.boolean().default(true),
  provider: z.enum(['s3']).default('s3'),
  endpoint: z.string().url(),
  bucket: z.string().min(1),
  region: z.string().min(1),
  log_interval_ms: z.number().min(60000).default(300000),
  full_interval_hours: z.number().min(1).default(24),
  retention_days: z.number().min(1).default(30),
});

export const RetentionConfig = z.object({
  max_age_days: z.number().min(1).default(90),
  max_tasks: z.number().min(1).default(10000),
  run_on_startup: z.boolean().default(true),
  run_daily_at: z.string().regex(/^\d{2}:\d{2}$/).default('03:00'),
  keep_failed_tasks: z.boolean().default(true),
});

export const LoggingConfig = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  pretty: z.boolean().default(false),
});

export const Config = z.object({
  server: ServerConfig.default({}),
  auth: AuthConfig.default({}),
  execution: ExecutionConfig.required(),
  judge: JudgeConfig.default({}),
  paths: PathsConfig.default({}),
  env: EnvConfig.default({}),
  executors: ExecutorsConfig.default({}),
  docker: DockerConfig.default({}),
  worktree: WorktreeConfig.default({}),
  backup: BackupConfig.required(),
  retention: RetentionConfig.default({}),
  logging: LoggingConfig.default({}),
});

export type Config = z.infer<typeof Config>;
