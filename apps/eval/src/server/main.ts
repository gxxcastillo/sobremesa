#!/usr/bin/env bun
import 'dotenv/config';
import { createDatabaseClient } from '@sobremesa/database';
import { createApp } from './app';
import { responseReplayStatus } from './providers';
import { EvalStore } from './store';

/**
 * Refuses a non-local SUPABASE_URL unless explicitly opted in, mirroring
 * `tests/live-db-test-utils.ts`'s `assertLocalUnlessAllowed` — this
 * app makes read-only family/event queries only, but there is no reason it
 * should ever point at a real deployed database by accident.
 */
function isLocalSupabaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
}

function assertLocalUnlessAllowed(url: string): void {
  if (!isLocalSupabaseUrl(url) && process.env['EVAL_ALLOW_REMOTE_DB'] !== '1') {
    throw new Error(
      'Refusing to run apps/eval against a non-local SUPABASE_URL. ' +
        'Set EVAL_ALLOW_REMOTE_DB=1 only for an intentional disposable database.',
    );
  }
}

const supabaseUrl = process.env['SUPABASE_URL'];
const supabaseAnonKey = process.env['SUPABASE_ANON_KEY'];
const supabaseServiceRoleKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];

if (!supabaseUrl || !supabaseAnonKey) {
  console.error(
    '❌ Missing required environment variables: SUPABASE_URL, SUPABASE_ANON_KEY',
  );
  process.exit(1);
}
assertLocalUnlessAllowed(supabaseUrl);

const dbClient = createDatabaseClient({
  url: supabaseUrl,
  anonKey: supabaseAnonKey,
  serviceRoleKey: supabaseServiceRoleKey,
});

const store = new EvalStore(
  process.env['EVAL_DB_PATH'] ?? `${import.meta.dir}/../../tmp/eval.db`,
);

const app = createApp({ dbClient, store });

const port = parseInt(process.env['PORT'] || '3002', 10);
app.listen({ port, hostname: 'localhost' }, () => {
  console.log(`🧪 Eval API running on http://localhost:${port}`);
  console.log(`   Health check: http://localhost:${port}/health`);
  console.log(
    responseReplayStatus.enabled
      ? `   LLM response replay: ON — ${responseReplayStatus.dbPath}`
      : '   LLM response replay: off (set LLM_RESPONSE_REPLAY=1 to replay recorded responses)',
  );
});
