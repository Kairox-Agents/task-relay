import { Hono } from 'hono';
import type { Config } from '../../config/schema.js';

export function createCapabilitiesRoute(config: Config) {
  const router = new Hono();

  /**
   * GET /capabilities - List available executors and capabilities
   */
  router.get('/', (c) => {
    const capabilities = {
      version: '0.1.0',
      executors: [
        {
          type: 'shell',
          enabled: config.executors.shell.enabled,
          supported_isolation: ['host'], // Shell only works in host mode
        },
        {
          type: 'claude-code',
          enabled: config.executors['claude-code'].enabled,
          supported_isolation: ['docker', 'host', 'worktree'],
        },
      ],
      isolation: {
        default: config.execution.default_isolation,
        available: ['docker', 'host', 'worktree'],
      },
      features: {
        judge_loop: config.judge.enabled,
        worktree_isolation: config.worktree.enabled,
        backup: config.backup.enabled,
      },
      limits: {
        max_concurrent: config.execution.max_concurrent,
        max_queue_size: config.execution.max_queue_size,
        max_timeout_ms: config.execution.max_timeout_ms,
      },
    };

    return c.json(capabilities);
  });

  return router;
}
