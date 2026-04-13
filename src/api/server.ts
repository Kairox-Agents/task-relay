import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { createAuthMiddleware } from './middleware/auth.js';
import { createTasksRoute } from './routes/tasks.js';
import { createHealthRoute } from './routes/health.js';
import { createCapabilitiesRoute } from './routes/capabilities.js';
import { createErrorResponse, ApiError } from './errors.js';
import type { Config } from '../config/schema.js';
import type { TaskRepository } from '../db/tasks.js';
import type { TaskQueue } from '../executor/queue.js';

export function createServer(
  config: Config,
  taskRepo: TaskRepository,
  taskQueue: TaskQueue
) {
  const app = new Hono();

  // Middleware
  app.use('*', cors());
  app.use('*', honoLogger());

  // Public routes (no auth)
  const healthRoute = createHealthRoute();
  app.route('/health', healthRoute);

  // Authenticated routes
  const authMiddleware = createAuthMiddleware(config.auth.api_keys);

  const tasksRoute = createTasksRoute(
    taskRepo,
    taskQueue,
    config.execution.default_isolation,
    config.paths.allowed,
    config.env
  );
  const capabilitiesRoute = createCapabilitiesRoute(config);

  app.route('/tasks', tasksRoute);
  app.route('/capabilities', capabilitiesRoute);

  // Error handling
  app.onError((err, c) => {
    console.error('API Error:', err);

    if (err instanceof ApiError) {
      return c.json(createErrorResponse(err), err.statusCode);
    }

    // Unknown error
    return c.json(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
        },
      },
      500
    );
  });

  // 404 handler
  app.notFound((c) => {
    return c.json(
      {
        error: {
          code: 'NOT_FOUND',
          message: 'Endpoint not found',
        },
      },
      404
    );
  });

  return app;
}
