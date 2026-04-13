import type { MiddlewareHandler } from 'hono';
import type { ApiKeyConfig, ExecutorType, IsolationMode } from '../../config/schema.js';
import { ApiError, ERROR_CODES } from '../errors.js';

interface AuthContext {
  apiKeyId: string;
  allowedTypes?: ExecutorType[];
  allowedIsolation?: IsolationMode[];
}

/**
 * Create API key authentication middleware.
 */
export function createAuthMiddleware(apiKeys: ApiKeyConfig[]): MiddlewareHandler {
  const keyMap = new Map<string, ApiKeyConfig>(
    apiKeys.map((k) => [k.key, k])
  );

  return async (c, next) => {
    const authHeader = c.req.header('Authorization');

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new ApiError(ERROR_CODES.UNAUTHORIZED, 'Missing or invalid Authorization header', 401);
    }

    const apiKey = authHeader.slice(7); // Remove 'Bearer ' prefix
    const keyConfig = keyMap.get(apiKey);

    if (!keyConfig) {
      throw new ApiError(ERROR_CODES.UNAUTHORIZED, 'Invalid API key', 401);
    }

    // Store auth context in request
    c.set('auth', {
      apiKeyId: keyConfig.id,
      allowedTypes: keyConfig.allowed_types,
      allowedIsolation: keyConfig.allowed_isolation,
    } as AuthContext);

    await next();
  };
}

/**
 * Get auth context from request.
 */
export function getAuthContext(c: any): AuthContext | undefined {
  return c.get('auth');
}
