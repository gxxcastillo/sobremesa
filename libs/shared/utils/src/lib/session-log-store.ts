import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Just the `bun:sqlite` API surface this module uses, typed locally instead
 * of importing from `bun:sqlite` itself — that module specifier isn't
 * resolvable outside a Bun-run compilation, and consumers that reach this
 * file via a path-mapped source import (rather than this library's own
 * tsconfig) don't reliably see an ambient module declaration for it.
 */
interface BunSqliteDatabase {
  run(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): void };
}
interface BunSqliteModule {
  Database: new (
    filename: string,
    options?: { create?: boolean },
  ) => BunSqliteDatabase;
}

/**
 * SQLite sink for a process's session log (warn+ entries). Opened lazily and
 * reused for the process's life so every `createLogger` caller shares one
 * database file per session. Rows are only ever inserted, never updated or
 * deleted — append-only by convention, not enforced by the schema.
 */
export interface SessionLogEntry {
  time: number;
  level: number;
  levelLabel: string;
  loggerName?: string;
  familyId?: string;
  msg?: string;
  data: Record<string, unknown>;
}

interface OpenStore {
  path: string;
  insert: { run(...params: unknown[]): void };
}

let store: OpenStore | null = null;

/**
 * `bun:sqlite` is loaded via `require`, not a top-level `import`, so this
 * module can still be loaded when the test suite runs under vitest's
 * Node-based module loader (which rejects the `bun:` protocol outright) —
 * this only actually executes when a warn/error is recorded, which no test
 * triggers.
 */
function loadDatabaseCtor(): BunSqliteModule['Database'] {
  return (require('bun:sqlite') as BunSqliteModule).Database;
}

function getStore(path: string): OpenStore {
  if (store && store.path === path) return store;

  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const Database = loadDatabaseCtor();
  const db = new Database(path, { create: true });
  db.run(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time INTEGER NOT NULL,
      level INTEGER NOT NULL,
      level_label TEXT NOT NULL,
      logger_name TEXT,
      family_id TEXT,
      msg TEXT,
      data TEXT NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_logs_family_id ON logs(family_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_logs_time ON logs(time)`);

  const insert = db.prepare(
    `INSERT INTO logs (time, level, level_label, logger_name, family_id, msg, data) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  store = { path, insert };
  return store;
}

/**
 * Record one session-log entry. Never throws — a broken session log must
 * never take down the real work whose warning/error it's recording.
 */
export function recordSessionLogEntry(
  path: string,
  entry: SessionLogEntry,
): void {
  try {
    const { insert } = getStore(path);
    insert.run(
      entry.time,
      entry.level,
      entry.levelLabel,
      entry.loggerName ?? null,
      entry.familyId ?? null,
      entry.msg ?? null,
      JSON.stringify(entry.data),
    );
  } catch {
    // best-effort only
  }
}
