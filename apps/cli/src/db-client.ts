import { createDatabaseClient, type DatabaseClient } from '@sobremesa/database';

function isLocalSupabaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
}

/**
 * Builds a DB client from SUPABASE_URL/SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY,
 * refusing a non-local URL unless the caller explicitly opted in. Mirrors
 * `tests/live-db-test-utils.ts`'s guard -- duplicated here rather than
 * imported across the apps/cli <-> tests/ Nx project boundary, which
 * `@nx/enforce-module-boundaries` rejects for relative cross-project
 * imports (and `@sobremesa/tests` is a script project with no package
 * exports to import by).
 */
export function createLiveDbClient(
  context: string,
  allowRemoteDb: boolean,
): DatabaseClient {
  const url = process.env['SUPABASE_URL'];
  const anonKey = process.env['SUPABASE_ANON_KEY'];
  const serviceRoleKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (!url || !anonKey || !serviceRoleKey) {
    throw new Error(
      `${context} require SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY.`,
    );
  }
  if (!allowRemoteDb && !isLocalSupabaseUrl(url)) {
    throw new Error(
      'Refusing to run against a non-local SUPABASE_URL. Pass --allow-remote-db only for an intentional disposable database.',
    );
  }
  return createDatabaseClient({ url, anonKey, serviceRoleKey });
}
