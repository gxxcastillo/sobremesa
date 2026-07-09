/**
 * Shared scaffold for scripts/tests/*.ts live-DB integration scripts: env/host
 * guarding, family-fixture-friendly random suffixes, and a common
 * run-scenarios-and-summarize loop. Manual only -- not part of test:all/CI
 * (per AGENTS.md, no live-DB calls belong there).
 */
import { createDatabaseClient } from '../../libs/database/src/lib/client.js';

export interface ScenarioResult {
  name: string;
  passed: boolean;
  detail: string;
}

export interface Scenario {
  name: string;
  run: () => Promise<ScenarioResult>;
}

export interface LiveDbEnv {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
}

export function isLocalSupabaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
}

export function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Throws with a context-specific message if the live-DB env vars are missing. */
export function requireLiveDbEnv(context: string): LiveDbEnv {
  const url = process.env['SUPABASE_URL'];
  const anonKey = process.env['SUPABASE_ANON_KEY'];
  const serviceRoleKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (!url || !anonKey || !serviceRoleKey) {
    throw new Error(
      `${context} require SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY.`,
    );
  }
  return { url, anonKey, serviceRoleKey };
}

/** Refuses a non-local URL unless the caller explicitly opted in. */
export function assertLocalUnlessAllowed(
  url: string,
  allowRemoteDb: boolean,
): void {
  if (!allowRemoteDb && !isLocalSupabaseUrl(url)) {
    throw new Error(
      'Refusing to run against a non-local SUPABASE_URL. Pass --allow-remote-db only for an intentional disposable database.',
    );
  }
}

export function createLiveDbClient(context: string, allowRemoteDb: boolean) {
  const env = requireLiveDbEnv(context);
  assertLocalUnlessAllowed(env.url, allowRemoteDb);
  return createDatabaseClient(env);
}

/** Runs each scenario, prints a pass/fail summary, and exits with the appropriate code. */
export async function runScenarios(
  scenarios: Scenario[],
  messages: { allPassed: string; someFailed: (failedCount: number) => string },
): Promise<void> {
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    console.log(`Running ${scenario.name}...`);
    try {
      const result = await scenario.run();
      results.push(result);
      console.log(`  ${result.passed ? '✓' : '✗'} ${result.detail}\n`);
    } catch (err) {
      results.push({
        name: scenario.name,
        passed: false,
        detail: `threw: ${err instanceof Error ? err.message : String(err)}`,
      });
      console.log(`  ✗ threw: ${err instanceof Error ? err.message : err}\n`);
    }
  }

  const failed = results.filter((r) => !r.passed);
  console.log('=== Summary ===');
  for (const result of results) {
    console.log(`  ${result.passed ? 'PASS' : 'FAIL'}  ${result.name}`);
  }
  console.log(
    failed.length === 0
      ? `\n${messages.allPassed}`
      : `\n${messages.someFailed(failed.length)}`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}
