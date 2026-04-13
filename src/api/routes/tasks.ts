import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import type { Task, IsolationMode } from '../../config/schema.js';
import { TaskRepository } from '../../db/tasks.js';
import { TaskQueue } from '../../executor/queue.js';
import { registry } from '../../executor/registry.js';
import { ApiError, ERROR_CODES } from '../errors.js';
import { getAuthContext } from '../middleware/auth.js';
import { validateBody, getValidatedBody } from '../middleware/validation.js';
import { isAllowedPath, validateEnvVars } from '../../utils/env.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger();

// Request schema for task submission
const CreateTaskSchema = z.object({
  type: z.enum(['shell', 'claude-code']),
  prompt: z.string().min(1),
  working_dir: z.string().min(1),
  isolation: z.enum(['docker', 'host', 'worktree']).optional(),
  timeout_ms: z.number().min(1000).max(3600000).optional(),
  env: z.record(z.string()).optional(),
  allow_network: z.boolean().optional(),
  model: z.string().optional(),
  max_budget_usd: z.number().min(0.01).max(100.0).optional(),
  acceptance_criteria: z.string().nullable().optional(),
  max_iterations: z.number().min(1).max(20).optional(),
  judge_model: z.string().nullable().optional(),
});

export function createTasksRoute(
  taskRepo: TaskRepository,
  taskQueue: TaskQueue,
  defaultIsolation: IsolationMode,
  allowedPaths: string[],
  envConfig: any
) {
  const router = new Hono();

  /**
   * POST /tasks - Submit a new task
   */
  router.post('/', validateBody(CreateTaskSchema), async (c) => {
    const auth = getAuthContext(c);
    const body = getValidatedBody<z.infer<typeof CreateTaskSchema>>(c);

    // Check isolation mode
    const isolation = body.isolation || defaultIsolation;
    if (auth?.allowedIsolation && !auth.allowedIsolation.includes(isolation)) {
      throw new ApiError(ERROR_CODES.ISOLATION_NOT_ALLOWED, `Isolation mode ${isolation} not allowed for this API key`);
    }

    // Check working directory is allowed
    if (!isAllowedPath(body.working_dir, allowedPaths)) {
      throw new ApiError(ERROR_CODES.PATH_NOT_ALLOWED, `Working directory ${body.working_dir} is not allowed`);
    }

    // Check executor type
    if (auth?.allowedTypes && !auth.allowedTypes.includes(body.type)) {
      throw new ApiError(ERROR_CODES.FORBIDDEN, `Executor type ${body.type} not allowed for this API key`);
    }

    const executor = registry.findExecutor(body.type);
    if (!executor) {
      throw new ApiError(ERROR_CODES.EXECUTOR_NOT_FOUND, `Executor for type ${body.type} not found`);
    }

    // Validate environment variables
    const env = body.env ? validateEnvVars(body.env, envConfig) : {};

    // Create task
    const now = new Date().toISOString();
    const task: Task = {
      id: uuidv4(),
      type: body.type,
      prompt: body.prompt,
      working_dir: body.working_dir,
      isolation,
      timeout_ms: body.timeout_ms || 300000,
      env,
      allow_network: body.allow_network || false,
      model: body.model || 'sonnet',
      max_budget_usd: body.max_budget_usd || 1.0,
      acceptance_criteria: body.acceptance_criteria || null,
      max_iterations: body.max_iterations || 5,
      judge_model: body.judge_model || null,
      current_iteration: 1,
      judge_history: [],
      judge_result: null,
      status: 'pending',
      created_at: now,
      started_at: null,
      completed_at: null,
      exit_code: null,
      error: null,
      output_path: null,
      cost_usd: 0,
    };

    // Save to database
    taskRepo.create(task);

    // Add to queue
    const added = taskQueue.add(task);
    if (!added) {
      throw new ApiError(ERROR_CODES.QUEUE_FULL, 'Task queue is full');
    }

    logger.info({ taskId: task.id, type: task.type, isolation }, 'Task submitted');

    return c.json({ id: task.id, status: task.status }, 201);
  });

  /**
   * GET /tasks/:id - Get task status
   */
  router.get('/:id', (c) => {
    const id = c.req.param('id');
    const task = taskRepo.getById(id);

    if (!task) {
      throw new ApiError(ERROR_CODES.TASK_NOT_FOUND, 'Task not found', 404);
    }

    // Return sanitized task (exclude prompt for security)
    const response = {
      id: task.id,
      type: task.type,
      working_dir: task.working_dir,
      isolation: task.isolation,
      status: task.status,
      created_at: task.created_at,
      started_at: task.started_at,
      completed_at: task.completed_at,
      exit_code: task.exit_code,
      error: task.error,
      cost_usd: task.cost_usd,
    };

    return c.json(response);
  });

  /**
   * GET /tasks - List tasks
   */
  router.get('/', (c) => {
    const status = c.req.query('status') as any;
    const limit = parseInt(c.req.query('limit') || '100', 10);
    const offset = parseInt(c.req.query('offset') || '0', 10);

    const tasks = taskRepo.list(status, limit, offset);

    return c.json({
      tasks: tasks.map((t) => ({
        id: t.id,
        type: t.type,
        status: t.status,
        created_at: t.created_at,
        working_dir: t.working_dir,
      })),
      total: tasks.length,
    });
  });

  /**
   * DELETE /tasks/:id - Cancel/delete a task
   */
  router.delete('/:id', (c) => {
    const id = c.req.param('id');
    const task = taskRepo.getById(id);

    if (!task) {
      throw new ApiError(ERROR_CODES.TASK_NOT_FOUND, 'Task not found', 404);
    }

    if (task.status === 'running') {
      // Mark as cancelled
      taskRepo.updateStatus(id, 'cancelled');
      logger.warn({ taskId: id }, 'Task cancelled');
    } else {
      // Delete if not running
      taskRepo.delete(id);
      logger.info({ taskId: id }, 'Task deleted');
    }

    return c.json({ id, status: 'cancelled' });
  });

  /**
   * GET /tasks/:id/stream - SSE stream for task events
   */
  router.get('/:id/stream', (c) => {
    const id = c.req.param('id');
    const task = taskRepo.getById(id);

    if (!task) {
      throw new ApiError(ERROR_CODES.TASK_NOT_FOUND, 'Task not found', 404);
    }

    // Setup SSE
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        // Send initial status
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'status', status: task.status })}\n\n`));

        // TODO: Set up event listener for task status changes
        // This will require the queue to emit events that we can listen to

        // Keep connection alive
        const keepAlive = setInterval(() => {
          controller.enqueue(encoder.encode(': keep-alive\n\n'));
        }, 30000);

        // Clean up on disconnect
        c.req.raw.signal?.addEventListener('abort', () => {
          clearInterval(keepAlive);
          controller.close();
        });
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  });

  return router;
}
