import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { createTasksRoute } from './routes/tasks.js';
import { createHealthRoute } from './routes/health.js';
import { createCapabilitiesRoute } from './routes/capabilities.js';
import { createAuthMiddleware } from './middleware/auth.js';
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

  // Auth middleware
  const authMiddleware = createAuthMiddleware(config.auth.api_keys);

  const tasksRoute = createTasksRoute(
    taskRepo,
    taskQueue,
    config.execution.default_isolation,
    config.paths.allowed,
    config.env
  );
  const capabilitiesRoute = createCapabilitiesRoute(config);

  // Apply auth middleware to protected routes
  const protectedTasks = new Hono();
  protectedTasks.use('*', authMiddleware);
  protectedTasks.route('/', tasksRoute);

  const protectedCapabilities = new Hono();
  protectedCapabilities.use('*', authMiddleware);
  protectedCapabilities.route('/', capabilitiesRoute);

  app.route('/tasks', protectedTasks);
  app.route('/capabilities', protectedCapabilities);

  // Error handling
  app.onError((err, c) => {
    console.error('API Error:', err);

    if (err instanceof ApiError) {
      return c.json(createErrorResponse(err), err.statusCode as any);
    }

    // Unknown error
    return c.json(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
        },
      },
      500 as any
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
      404 as any
    );
  });

  return app;
}
