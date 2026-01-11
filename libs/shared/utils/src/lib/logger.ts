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
}

/**
 * Create a configured logger instance.
 */
export function createLogger(options: LoggerOptions): pino.Logger {
  const { name, level = 'info', familyId } = options;

  const baseConfig: pino.LoggerOptions = {
    name,
    level: process.env['LOG_LEVEL'] || level,
  };

  // Add pretty printing in development
  if (process.env['NODE_ENV'] !== 'production') {
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

  // Bind familyId if provided
  if (familyId) {
    return logger.child({ familyId });
  }

  return logger;
}

/**
 * Default application logger.
 */
export const logger = createLogger({ name: 'sobremesa' });

/**
 * Create a child logger with additional context.
 */
export function childLogger(
  parent: pino.Logger,
  context: Record<string, unknown>
): pino.Logger {
  return parent.child(context);
}
