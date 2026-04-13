import pino from 'pino';
import type { LoggingConfig } from '../config/schema.js';

let logger: pino.Logger | null = null;

/**
 * Initialize logger with config.
 */
export function initLogger(config: LoggingConfig): pino.Logger {
  const options: pino.LoggerOptions = {
    level: config.level,
    serializers: {
      err: pino.stdSerializers.err,
    },
  };

  if (config.pretty) {
    options.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname',
      },
    };
  }

  logger = pino(options);
  return logger;
}

/**
 * Get the global logger instance.
 */
export function getLogger(): pino.Logger {
  if (!logger) {
    // Fallback if not initialized
    logger = pino({ level: 'info' });
  }
  return logger;
}
