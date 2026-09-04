import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Dev-tooling run/annotation history, local only (never canonical family
 * data — see eval-site-plan.md decision #6). One file per checkout under
 * `apps/eval/tmp/`, covered by the root .gitignore's bare `tmp` pattern.
 */

export interface StoredRun {
  id: string;
  createdAt: string;
  input: unknown;
  configs: unknown;
  results: unknown;
}

export type RunSummary = Omit<StoredRun, 'results'>;

export interface StoredAnnotation {
  id: string;
  runId: string;
  target: unknown;
  verdict: 'good' | 'bad';
  note: string | null;
  createdAt: string;
}

interface RunRow {
  id: string;
  created_at: string;
  input_json: string;
  configs_json: string;
  results_json: string;
  family_id: string | null;
  event_id: string | null;
}

interface AnnotationRow {
  id: string;
  run_id: string;
  target_json: string;
  verdict: string;
  note: string | null;
  created_at: string;
}

export interface StoredFamilyGolden {
  id: string;
  familyIdLo: string;
  familyIdHi: string;
  golden: unknown;
  createdAt: string;
  updatedAt: string;
}

interface FamilyGoldenRow {
  id: string;
  family_id_lo: string;
  family_id_hi: string;
  golden_json: string;
  created_at: string;
  updated_at: string;
}

export class EvalStore {
  private readonly db: Database;

  constructor(path: string) {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(path, { create: true });
    this.db.run(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        input_json TEXT NOT NULL,
        configs_json TEXT NOT NULL,
        results_json TEXT NOT NULL
      )
    `);
    // `family_id`/`event_id`: indexed projections of `input.familyId`/
    // `input.eventId`, NULL for `scenario`/`adhoc` runs (neither has a
    // message). `input_json` stays the full polymorphic record; these
    // columns exist only so "which runs reference this event" is an indexed
    // lookup instead of a recency-bounded scan — a bounded LIMIT can never
    // reliably answer "does a run exist for this event" once a family
    // accumulates more runs than the limit. Added after `runs` already
    // shipped, so backfill existing rows from input_json below.
    const runColumns = new Set(
      (
        this.db.query(`PRAGMA table_info(runs)`).all() as Array<{
          name: string;
        }>
      ).map((c) => c.name),
    );
    if (!runColumns.has('family_id')) {
      this.db.run(`ALTER TABLE runs ADD COLUMN family_id TEXT`);
    }
    if (!runColumns.has('event_id')) {
      this.db.run(`ALTER TABLE runs ADD COLUMN event_id TEXT`);
    }
    this.db.run(`
      UPDATE runs
      SET family_id = json_extract(input_json, '$.familyId'),
          event_id = json_extract(input_json, '$.eventId')
      WHERE family_id IS NULL
        AND event_id IS NULL
        AND json_extract(input_json, '$.kind') = 'real'
    `);
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_runs_family_id ON runs (family_id)`,
    );
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_runs_event_id ON runs (event_id)`,
    );
    this.db.run(`
      CREATE TABLE IF NOT EXISTS annotations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        target_json TEXT NOT NULL,
        verdict TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL
      )
    `);
    // One-time cleanup ahead of the unique index below: earlier versions of
    // this store always INSERTed, so re-annotating the same target (e.g.
    // flipping 👍 to 👎) left duplicate rows for the same (run_id,
    // target_json) in this gitignored dev file. Keep the most recently
    // inserted row per pair, drop the rest, so the index creation below
    // doesn't fail on pre-existing duplicates.
    this.db.run(`
      DELETE FROM annotations
      WHERE rowid NOT IN (
        SELECT MAX(rowid) FROM annotations GROUP BY run_id, target_json
      )
    `);
    this.db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_annotations_run_target
      ON annotations (run_id, target_json)
    `);
    // One working golden draft per unordered family pair (Family Compare's
    // "build a golden" editor) — `family_id_lo`/`family_id_hi` sort the pair
    // so picking the same two families with A/B swapped on a later visit
    // still finds the same draft.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS family_goldens (
        id TEXT PRIMARY KEY,
        family_id_lo TEXT NOT NULL,
        family_id_hi TEXT NOT NULL,
        golden_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_family_goldens_pair
      ON family_goldens (family_id_lo, family_id_hi)
    `);
  }

  insertRun(run: {
    id: string;
    input: unknown;
    configs: unknown;
    results: unknown;
  }): StoredRun {
    const createdAt = new Date().toISOString();
    const input = run.input as {
      kind?: string;
      familyId?: string;
      eventId?: string;
    };
    const familyId = input?.kind === 'real' ? (input.familyId ?? null) : null;
    const eventId = input?.kind === 'real' ? (input.eventId ?? null) : null;
    this.db.run(
      `INSERT INTO runs (id, created_at, input_json, configs_json, results_json, family_id, event_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        run.id,
        createdAt,
        JSON.stringify(run.input),
        JSON.stringify(run.configs),
        JSON.stringify(run.results),
        familyId,
        eventId,
      ],
    );
    return {
      id: run.id,
      createdAt,
      input: run.input,
      configs: run.configs,
      results: run.results,
    };
  }

  /**
   * `familyId`/`eventIds` scope to runs of matching real messages (indexed
   * columns, not a JSON scan). `eventIds` is an authoritative lookup —
   * "does a run exist for exactly these events" — so it's never truncated
   * by `limit`: a bounded recency window can silently say "no" for an old
   * message that has a perfectly valid recorded run, once a family
   * accumulates more runs than the limit. `limit` (default 50) only caps
   * the plain recency-browse case, with no `familyId`/`eventIds` filter —
   * what Run History uses.
   */
  listRuns(
    options: {
      limit?: number;
      familyId?: string;
      eventIds?: string[];
    } = {},
  ): RunSummary[] {
    const { familyId, eventIds } = options;
    if (eventIds?.length === 0) return [];

    const conditions: string[] = [];
    const params: string[] = [];
    if (familyId !== undefined) {
      conditions.push(`family_id = ?`);
      params.push(familyId);
    }
    if (eventIds !== undefined) {
      conditions.push(`event_id IN (${eventIds.map(() => '?').join(',')})`);
      params.push(...eventIds);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? (eventIds === undefined ? 50 : undefined);
    const limitClause = limit !== undefined ? `LIMIT ?` : '';
    const allParams = limit !== undefined ? [...params, limit] : params;
    const rows = this.db
      .query(
        `SELECT id, created_at, input_json, configs_json FROM runs ${where} ORDER BY created_at DESC ${limitClause}`,
      )
      .all(...allParams) as Array<Omit<RunRow, 'results_json'>>;
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      input: JSON.parse(row.input_json),
      configs: JSON.parse(row.configs_json),
    }));
  }

  getRun(id: string): StoredRun | null {
    const row = this.db.query(`SELECT * FROM runs WHERE id = ?`).get(id) as
      | RunRow
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      createdAt: row.created_at,
      input: JSON.parse(row.input_json),
      configs: JSON.parse(row.configs_json),
      results: JSON.parse(row.results_json),
    };
  }

  /**
   * Upserts on `(run_id, target_json)` — re-annotating the same target (a
   * verdict flip, or the same content re-run) updates the existing row in
   * place instead of appending a new one, so `listAnnotations` always has at
   * most one row per target and the latest verdict is the only one that can
   * show.
   */
  insertAnnotation(annotation: {
    id: string;
    runId: string;
    target: unknown;
    verdict: 'good' | 'bad';
    note?: string;
  }): StoredAnnotation {
    const createdAt = new Date().toISOString();
    const targetJson = JSON.stringify(annotation.target);
    this.db.run(
      `INSERT INTO annotations (id, run_id, target_json, verdict, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, target_json) DO UPDATE SET
         verdict = excluded.verdict,
         note = excluded.note,
         created_at = excluded.created_at`,
      [
        annotation.id,
        annotation.runId,
        targetJson,
        annotation.verdict,
        annotation.note ?? null,
        createdAt,
      ],
    );
    const row = this.db
      .query(`SELECT * FROM annotations WHERE run_id = ? AND target_json = ?`)
      .get(annotation.runId, targetJson) as AnnotationRow;
    return {
      id: row.id,
      runId: row.run_id,
      target: JSON.parse(row.target_json),
      verdict: row.verdict as 'good' | 'bad',
      note: row.note,
      createdAt: row.created_at,
    };
  }

  listAnnotations(runId: string): StoredAnnotation[] {
    const rows = this.db
      .query(
        `SELECT * FROM annotations WHERE run_id = ? ORDER BY created_at ASC`,
      )
      .all(runId) as AnnotationRow[];
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      target: JSON.parse(row.target_json),
      verdict: row.verdict as 'good' | 'bad',
      note: row.note,
      createdAt: row.created_at,
    }));
  }

  private static sortPair(
    familyIdA: string,
    familyIdB: string,
  ): [string, string] {
    return familyIdA <= familyIdB
      ? [familyIdA, familyIdB]
      : [familyIdB, familyIdA];
  }

  getFamilyGolden(
    familyIdA: string,
    familyIdB: string,
  ): StoredFamilyGolden | null {
    const [lo, hi] = EvalStore.sortPair(familyIdA, familyIdB);
    const row = this.db
      .query(
        `SELECT * FROM family_goldens WHERE family_id_lo = ? AND family_id_hi = ?`,
      )
      .get(lo, hi) as FamilyGoldenRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      familyIdLo: row.family_id_lo,
      familyIdHi: row.family_id_hi,
      golden: JSON.parse(row.golden_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Upserts on the sorted pair — always one draft per two families, however A/B were assigned this visit. */
  saveFamilyGolden(
    familyIdA: string,
    familyIdB: string,
    golden: unknown,
  ): StoredFamilyGolden {
    const [lo, hi] = EvalStore.sortPair(familyIdA, familyIdB);
    const now = new Date().toISOString();
    const existing = this.getFamilyGolden(lo, hi);
    const id = existing?.id ?? crypto.randomUUID();
    const createdAt = existing?.createdAt ?? now;
    this.db.run(
      `INSERT INTO family_goldens (id, family_id_lo, family_id_hi, golden_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(family_id_lo, family_id_hi) DO UPDATE SET
         golden_json = excluded.golden_json,
         updated_at = excluded.updated_at`,
      [id, lo, hi, JSON.stringify(golden), createdAt, now],
    );
    return {
      id,
      familyIdLo: lo,
      familyIdHi: hi,
      golden,
      createdAt,
      updatedAt: now,
    };
  }
}
