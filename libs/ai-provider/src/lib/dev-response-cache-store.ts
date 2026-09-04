import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DevResponseCacheStore } from './providers/caching';
import type { AICompletionRequest, AICompletionResponse } from './types';

/**
 * Just the `bun:sqlite` surface used here, typed locally instead of imported
 * -- that module specifier isn't resolvable outside a Bun-run compilation,
 * and this library's tests run under vitest's Node-based module loader,
 * which rejects the `bun:` protocol outright at import time. Same pattern as
 * `libs/shared/utils/src/lib/session-log-store.ts`.
 */
interface BunSqliteStatement {
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): void;
}
interface BunSqliteDatabase {
  run(sql: string): void;
  query(sql: string): BunSqliteStatement;
  prepare(sql: string): BunSqliteStatement;
}
interface BunSqliteModule {
  Database: new (
    filename: string,
    options?: { create?: boolean },
  ) => BunSqliteDatabase;
}

/**
 * Loaded via `require`, not a top-level `import`, so this module can still
 * be loaded under vitest -- only actually executed by a caller that
 * constructs `SqliteDevResponseCacheStore`, which no test does.
 */
function loadDatabaseCtor(): BunSqliteModule['Database'] {
  return (require('bun:sqlite') as BunSqliteModule).Database;
}

interface ResponseRow {
  response_json: string;
}

/**
 * Sqlite-backed `DevResponseCacheStore`: one row per distinct
 * (model + rendered prompt + params) hash, storing the raw request alongside
 * the response so the file also doubles as an inspectable record of what got
 * replayed. Dev tooling only -- see `CachingProvider`.
 */
export class SqliteDevResponseCacheStore implements DevResponseCacheStore {
  private readonly db: BunSqliteDatabase;
  private readonly insertStmt: BunSqliteStatement;

  constructor(path: string) {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const Database = loadDatabaseCtor();
    this.db = new Database(path, { create: true });
    this.db.run(`
      CREATE TABLE IF NOT EXISTS responses (
        key TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        request_json TEXT NOT NULL,
        response_json TEXT NOT NULL,
        cached_at TEXT NOT NULL
      )
    `);
    this.insertStmt = this.db.prepare(
      `INSERT OR REPLACE INTO responses (key, model, request_json, response_json, cached_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
  }

  get(key: string): AICompletionResponse | undefined {
    const row = this.db
      .query(`SELECT response_json FROM responses WHERE key = ?`)
      .get(key) as ResponseRow | null;
    if (!row) return undefined;
    return JSON.parse(row.response_json);
  }

  set(
    key: string,
    request: AICompletionRequest,
    response: AICompletionResponse,
  ): void {
    this.insertStmt.run(
      key,
      request.model,
      JSON.stringify(request),
      JSON.stringify(response),
      new Date().toISOString(),
    );
  }
}
