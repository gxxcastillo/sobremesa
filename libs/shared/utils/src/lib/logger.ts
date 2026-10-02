import pino from 'pino';
import { join } from 'node:path';
import { recordSessionLogEntry } from './session-log-store';

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
 * SQLite database capturing every warn+ log across this process, gated by
 * SESSION_LOG so it stays opt-in and is never enabled in production
 * regardless of that flag. Resolved once per process (not per
 * `createLogger` call) so every logger in a session shares one database.
 */
const SESSION_LOG_PATH = resolveSessionLogPath();

export function resolveSessionLogPath(): string | undefined {
  if (process.env['NODE_ENV'] === 'production') return undefined;
  const enabled = process.env['SESSION_LOG'];
  if (!enabled || /^(0|false)$/i.test(enabled)) return undefined;
  if (process.env['SESSION_LOG_PATH']) return process.env['SESSION_LOG_PATH'];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(
    process.cwd(),
    'tmp',
    'session-logs',
    `session-${stamp}-${process.pid}.db`,
  );
}

/**
 * `JSON.stringify` serializes a bare `Error` to `{}` (its message/stack/name
 * are all non-enumerable), so replace any `Error` values found as direct
 * properties of the merging object with a plain, serializable shape before
 * it reaches `recordSessionLogEntry`'s `JSON.stringify`. Covers the common
 * `logger.error({ error }, msg)` / `logger.warn({ err }, msg)` call shape,
 * not just an `Error` passed as pino's first positional argument.
 */
function serializeErrorValues(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  let out: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(obj)) {
    if (value instanceof Error) {
      out ??= { ...obj };
      out[key] = {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    }
  }
  return out ?? obj;
}

/**
 * Pulls the merging object and message out of a pino call's raw arguments —
 * `logger.warn(msg)`, `logger.warn(obj, msg)`, and `logger.warn(error, msg)`
 * are all valid call shapes.
 */
function extractLogFields(args: readonly unknown[]): {
  mergingObject: Record<string, unknown>;
  msg?: string;
} {
  const [first, second] = args;
  if (typeof first === 'string') {
    return { mergingObject: {}, msg: first };
  }
  if (first instanceof Error) {
    return {
      mergingObject: {
        err: { name: first.name, message: first.message, stack: first.stack },
      },
      msg: typeof second === 'string' ? second : undefined,
    };
  }
  if (first && typeof first === 'object') {
    return {
      mergingObject: serializeErrorValues(first as Record<string, unknown>),
      msg: typeof second === 'string' ? second : undefined,
    };
  }
  return { mergingObject: {} };
}

/**
 * Create a configured logger instance.
 *
 * @example
 * // Basic usage with defaults
 * const logger = createLogger({ name: 'my-app' });
 *
 * @example
 * // Override pretty mode explicitly
 * const logger = createLogger({
 *   name: 'my-app',
 *   level: process.env.LOG_LEVEL as LogLevel,
 *   pretty: false, // force JSON output
 * });
 */
export function createLogger(options: LoggerOptions): pino.Logger {
  const {
    name,
    level = 'info',
    familyId,
    pretty = process.env['NODE_ENV'] !== 'production',
  } = options;

  const baseConfig: pino.LoggerOptions = {
    name,
    level,
    // pino only serializes `err` by default; an Error logged under `error`
    // (the common call shape here) would otherwise print as `{}` and lose
    // its message and stack.
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
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

  if (SESSION_LOG_PATH) {
    const sessionLogPath = SESSION_LOG_PATH;
    baseConfig.hooks = {
      logMethod(args, method, methodLevel) {
        if (methodLevel >= pino.levels.values['warn']) {
          const bindings = this.bindings();
          const { mergingObject, msg } = extractLogFields(args);
          recordSessionLogEntry(sessionLogPath, {
            time: Date.now(),
            level: methodLevel,
            levelLabel: pino.levels.labels[methodLevel] ?? String(methodLevel),
            loggerName: name,
            familyId:
              (bindings['familyId'] as string | undefined) ??
              (mergingObject['familyId'] as string | undefined),
            msg,
            data: { ...bindings, ...mergingObject },
          });
        }
        return method.apply(this, args);
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

/**
 * Run `fn` for a side effect that follows a primary action that has already
 * taken effect (e.g. a message already sent to a chat). Failures are logged,
 * never rethrown: a caller that retries on failure would redo the primary
 * action too, so a secondary bookkeeping failure (an audit log write, a
 * queue-completion update) must not be indistinguishable from "nothing
 * happened yet."
 */
export async function logBestEffort(
  logger: pino.Logger,
  fn: () => Promise<unknown>,
  context: Record<string, unknown>,
  message: string,
  level: 'warn' | 'error' = 'warn',
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    logger[level]({ ...context, error }, message);
  }
}

/**
 * Every failure the pilot operator must notice (hardening J). Silence the
 * system chose (a follow-up decline, a pacing skip, an expiry) is never an
 * alert; only work that failed or is stuck is.
 */
export type AlertCategory =
  | 'queue_dead_letter'
  | 'queue_poll_error'
  | 'followup_provider_error'
  | 'followup_unparseable_response'
  | 'followup_hook_error'
  | 'send_failed'
  | 'send_unknown'
  | 'send_unresolved_skip';

/**
 * Log an operator alert: always ERROR level, always carrying `alert:
 * <category>` so a future notification sink can select alerts by that one
 * field without touching call sites. `context` should identify the affected
 * work (familyId, eventId, questionId, queue item id) -- never raw family
 * content.
 */
export function logAlert(
  logger: pino.Logger,
  category: AlertCategory,
  context: Record<string, unknown>,
  message: string,
): void {
  logger.error({ ...context, alert: category }, message);
}
