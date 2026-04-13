import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { ApiError, ERROR_CODES } from '../errors.js';

/**
 * Validate request body against a Zod schema.
 */
export function validateBody<T extends z.ZodTypeAny>(schema: T): MiddlewareHandler {
  return async (c, next) => {
    try {
      const body = await c.req.json();
      const validated = schema.parse(body);
      c.set('validatedBody', validated);
      await next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new ApiError(
          ERROR_CODES.VALIDATION_ERROR,
          error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')
        );
      }
      throw error;
    }
  };
}

/**
 * Get validated body from request.
 */
export function getValidatedBody<T>(c: any): T {
  return c.get('validatedBody') as T;
}
