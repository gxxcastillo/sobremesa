#!/usr/bin/env bun
/**
 * Verifies that every table defined across apps/db/supabase/migrations/*.sql
 * ends up in one of two safe states:
 *
 *   1. RLS-enabled AND granted SELECT/INSERT/UPDATE/DELETE to anon and
 *      authenticated (directly, or via the bootstrap privilege sweep in the
 *      init migration).
 *   2. Explicitly REVOKEd from anon/authenticated (a documented
 *      backend-only table, e.g. allowed_chats).
 *
 * A table that is neither is a silent gap: RLS-enabled tables without a
 * matching GRANT fail every client query with "permission denied" (the
 * policies are irrelevant if the GRANT is missing), and tables with no RLS
 * and no REVOKE are open to the anon key with no row-level restriction at
 * all. Run this after adding a migration that creates a table.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(import.meta.dir, '../supabase/migrations');

type EventType =
  | 'create'
  | 'enable_rls'
  | 'grant'
  | 'revoke'
  | 'sweep'
  | 'grant_all';

interface ParsedEvent {
  pos: number;
  type: EventType;
  table?: string;
}

const CREATE_TABLE_RE =
  /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(?:public\.)?(\w+)/gi;
const ENABLE_RLS_RE =
  /ALTER TABLE\s+(?:ONLY\s+)?(?:public\.)?(\w+)\s+ENABLE ROW LEVEL SECURITY/gi;
// The gap between the leading keyword and "ON TABLE"/"ON ALL TABLES" is
// `[^;]*?` (anything but a semicolon), not `[\s\S]*?` (anything at all) —
// `[\s\S]*?` can cross a statement terminator and lazily latch onto a much
// later, unrelated "ON TABLE ... TO/FROM ...;" clause, misreporting this
// statement's position as an earlier, unrelated one and scrambling the
// chronological grant/revoke ordering `parseEvents` depends on.
const GRANT_ON_TABLE_RE =
  /GRANT\s+[^;]*?\s+ON TABLE\s+(?:public\.)?(\w+)\s+TO\s+([^;]+);/gi;
const REVOKE_ON_TABLE_RE =
  /REVOKE\s+[^;]*?\s+ON TABLE\s+(?:public\.)?(\w+)\s+FROM\s+([^;]+);/gi;
const GRANT_ALL_TABLES_RE =
  /GRANT\s+[^;]*?\s+ON ALL TABLES IN SCHEMA\s+public\s+TO\s+([^;]+);/gi;
// The dynamic bootstrap sweep grants every already-RLS-enabled table to
// anon/authenticated by executing this exact template string per table.
const SWEEP_MARKER =
  'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %s TO anon, authenticated';

function mentionsClientRole(roleList: string): boolean {
  return /\banon\b/.test(roleList) || /\bauthenticated\b/.test(roleList);
}

// A commented-out `-- ALTER TABLE ... ENABLE ROW LEVEL SECURITY;` (or GRANT/
// REVOKE) must not be mistaken for the real statement.
function stripLineComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

function parseEvents(sql: string): ParsedEvent[] {
  const events: ParsedEvent[] = [];

  for (const m of sql.matchAll(CREATE_TABLE_RE)) {
    events.push({ pos: m.index ?? 0, type: 'create', table: m[1] });
  }
  for (const m of sql.matchAll(ENABLE_RLS_RE)) {
    events.push({ pos: m.index ?? 0, type: 'enable_rls', table: m[1] });
  }
  for (const m of sql.matchAll(GRANT_ON_TABLE_RE)) {
    if (mentionsClientRole(m[2])) {
      events.push({ pos: m.index ?? 0, type: 'grant', table: m[1] });
    }
  }
  for (const m of sql.matchAll(REVOKE_ON_TABLE_RE)) {
    if (mentionsClientRole(m[2])) {
      events.push({ pos: m.index ?? 0, type: 'revoke', table: m[1] });
    }
  }
  for (const m of sql.matchAll(GRANT_ALL_TABLES_RE)) {
    if (mentionsClientRole(m[1])) {
      events.push({ pos: m.index ?? 0, type: 'grant_all' });
    }
  }
  const sweepPos = sql.indexOf(SWEEP_MARKER);
  if (sweepPos !== -1) {
    events.push({ pos: sweepPos, type: 'sweep' });
  }

  return events.sort((a, b) => a.pos - b.pos);
}

function main(): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const allTables = new Set<string>();
  const rlsEnabledTables = new Set<string>();
  // Tracks each table's *current* client-role privilege state as of the
  // latest processed event. GRANT/REVOKE are last-write-wins in Postgres,
  // not monotonic — a table REVOKEd early and re-GRANTed later must be
  // judged on its final (granted) state, not flagged "ever revoked" and
  // skipped forever.
  const tableState = new Map<string, 'granted' | 'revoked'>();

  for (const file of files) {
    const sql = stripLineComments(
      readFileSync(join(MIGRATIONS_DIR, file), 'utf8'),
    );

    for (const event of parseEvents(sql)) {
      const { table } = event;
      switch (event.type) {
        case 'create':
          if (table) allTables.add(table);
          break;
        case 'enable_rls':
          if (table) rlsEnabledTables.add(table);
          break;
        case 'grant':
          if (table) tableState.set(table, 'granted');
          break;
        case 'revoke':
          if (table) tableState.set(table, 'revoked');
          break;
        case 'grant_all':
          for (const t of allTables) tableState.set(t, 'granted');
          break;
        case 'sweep':
          // Grants every table that is both created and RLS-enabled as of
          // this point in migration history.
          for (const table of allTables) {
            if (rlsEnabledTables.has(table)) tableState.set(table, 'granted');
          }
          break;
      }
    }
  }

  const errors: string[] = [];
  for (const table of allTables) {
    if (tableState.get(table) === 'revoked') continue;

    const hasRls = rlsEnabledTables.has(table);
    const isGranted = tableState.get(table) === 'granted';

    if (!hasRls) {
      errors.push(
        `${table}: no RLS enabled and no explicit REVOKE from anon/authenticated ` +
          `(either enable RLS with client grants, or REVOKE ALL ... FROM anon, authenticated to mark it backend-only)`,
      );
    } else if (!isGranted) {
      errors.push(
        `${table}: RLS is enabled but anon/authenticated has no table-level GRANT ` +
          `(RLS policies are checked in addition to GRANTs, not instead of them — add an explicit GRANT for this table)`,
      );
    }
  }

  if (errors.length > 0) {
    console.error('Table privilege check failed:\n');
    for (const err of errors) console.error(`  - ${err}`);
    console.error(
      `\n${errors.length} table(s) out of ${allTables.size} have an incomplete privilege setup.`,
    );
    process.exit(1);
  }

  console.log(
    `Table privilege check passed: ${allTables.size} tables, all RLS+granted or explicitly backend-only.`,
  );
}

main();
