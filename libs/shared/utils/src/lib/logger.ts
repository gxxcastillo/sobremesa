import pino from 'pino';

/**
 * Log levels supported by the logger.
 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * Logger configuration options.
 */
export interface LoggerOptions {
  name: string;
  level?: LogLevel;
  familyId?: string;
  /** Enable pretty printing (colorized, human-readable output) */
  pretty?: boolean;
}

/**
 * Create a configured logger instance.
 *
 * @example
 * // Basic usage with defaults
 * const logger = createLogger({ name: 'my-app' });
 *
 * @example
 * // With environment-based config (in app entry point)
 * const logger = createLogger({
 *   name: 'my-app',
 *   level: process.env.LOG_LEVEL as LogLevel,
 *   pretty: process.env.NODE_ENV !== 'production',
 * });
 */
export function createLogger(options: LoggerOptions): pino.Logger {
  const { name, level = 'info', familyId, pretty = false } = options;

  const baseConfig: pino.LoggerOptions = {
    name,
    level,
  };

  if (pretty) {
    baseConfig.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    };
  }

  const logger = pino(baseConfig);

  if (familyId) {
    return logger.child({ familyId });
  }

  return logger;
}

/**
 * Default application logger with minimal defaults.
 * For production use, create a logger with explicit config in your app entry point.
 */
export const logger = createLogger({ name: 'sobremesa' });

/**
 * Create a child logger with additional context.
 */
export function childLogger(
  parent: pino.Logger,
  context: Record<string, unknown>,
): pino.Logger {
  return parent.child(context);
}
