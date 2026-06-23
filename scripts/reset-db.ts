#!/usr/bin/env bun
/**
 * Reset database — truncates all data while preserving schema.
 *
 * Uses TRUNCATE CASCADE which bypasses row-level immutability triggers
 * and is near-instant regardless of data volume.
 *
 * Usage:
 *   bun scripts/reset-db.ts                    # local supabase (default)
 *   DATABASE_URL=... bun scripts/reset-db.ts   # custom connection
 */
import 'dotenv/config';
import { execSync } from 'child_process';

const dbUrl =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const sql = `
  TRUNCATE families, users, sequence_counters CASCADE;
`;

console.log('Resetting database...');

try {
  execSync(`psql "${dbUrl}" -c "${sql.trim()}"`, {
    stdio: 'inherit',
  });
  console.log('Done. All data cleared.');
} catch {
  console.error(
    '\nFailed. Is local supabase running? (supabase start from apps/db)',
  );
  process.exit(1);
}
