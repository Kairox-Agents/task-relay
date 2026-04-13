export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const ERROR_CODES = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  QUEUE_FULL: 'QUEUE_FULL',
  EXECUTOR_NOT_FOUND: 'EXECUTOR_NOT_FOUND',
  ISOLATION_NOT_ALLOWED: 'ISOLATION_NOT_ALLOWED',
  PATH_NOT_ALLOWED: 'PATH_NOT_ALLOWED',
  CONFIG_ERROR: 'CONFIG_ERROR',
} as const;

export function createErrorResponse(error: ApiError | Error) {
  if (error instanceof ApiError) {
    return {
      error: {
        code: error.code,
        message: error.message,
      },
    };
  }

  // Unknown error
  return {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    },
  };
}
