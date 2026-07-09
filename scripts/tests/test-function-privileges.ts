#!/usr/bin/env bun
/**
 * Live-DB regression test for function-level privilege exposure. A prior
 * bug showed migration-text review (and even `REVOKE ALL ... FROM PUBLIC`)
 * isn't enough: on this Supabase setup anon/authenticated get EXECUTE on
 * public-schema functions granted directly, not via PUBLIC, so a
 * PUBLIC-only revoke leaves them able to call functions meant to be
 * service_role-only. `delete_family_cascade` had exactly this gap and an
 * anon-only client (no auth at all) could hard-delete an arbitrary family
 * before it was closed (see .agents/extraction-hardening-plan.md item C).
 *
 * This drives the real RPC as an anon-only client (no service role key) --
 * a static check of migration text or grant lists can't catch this class of
 * bug, only a live call can. Manual only -- not part of test:all/CI (per
 * AGENTS.md, no live-DB calls belong there); requires `bun nx run db:start`
 * first.
 *
 * Run with: bun scripts/tests/test-function-privileges.ts
 */
import 'dotenv/config';
import { createDatabaseClient } from '../../libs/database/src/lib/client.js';
import type { DatabaseClient } from '../../libs/database/src/lib/client.js';
import {
  assertLocalUnlessAllowed,
  randomSuffix,
  requireLiveDbEnv,
  runScenarios,
  type ScenarioResult,
} from './live-db-test-utils.js';

// Functions that must never be callable by anon/authenticated, and how to
// probe each one. Add a new entry whenever a service_role-only function is
// introduced, so a broken grant is caught here instead of live.
const RESTRICTED_FUNCTIONS: Array<{
  name: string;
  probe: (
    adminClient: DatabaseClient,
    anonClient: DatabaseClient,
  ) => Promise<ScenarioResult>;
}> = [
  { name: 'delete_family_cascade', probe: probeDeleteFamilyCascade },
  {
    name: 'dequeue_processing_queue_item',
    probe: probeDequeueProcessingQueueItem,
  },
];

async function main(): Promise<void> {
  const allowRemoteDb = process.argv.includes('--allow-remote-db');
  const { adminClient, anonClient } = createDbClients(allowRemoteDb);

  await runScenarios(
    RESTRICTED_FUNCTIONS.map((fn) => ({
      name: fn.name,
      run: () => fn.probe(adminClient, anonClient),
    })),
    {
      allPassed: 'All restricted functions correctly deny anon.',
      someFailed: (count) =>
        `${count} function(s) are callable by anon -- fix the grant (see .agents/extraction-hardening-plan.md item C).`,
    },
  );
}

// delete_family_cascade is SECURITY DEFINER, owned by a BYPASSRLS role,
// and performs an unconditional hard delete with no internal authorization
// check -- its EXECUTE grant is its only access control, so this asserts
// the actual outcome (family survives), not just the error code.
async function probeDeleteFamilyCascade(
  adminClient: DatabaseClient,
  anonClient: DatabaseClient,
): Promise<ScenarioResult> {
  const name = 'delete_family_cascade';
  const { data: family, error: createError } = await adminClient
    .from('families')
    .insert({
      name: 'Function Privilege Probe',
      chat_source: 'telegram',
      chat_id: `fn-privilege-probe-${randomSuffix()}`,
      config: {},
    })
    .select('id')
    .single();
  if (createError || !family) {
    throw new Error(`Failed to create probe family: ${createError?.message}`);
  }

  try {
    const { error: rpcError } = await anonClient.rpc('delete_family_cascade', {
      p_family_id: family.id,
    });

    const { data: stillExists } = await adminClient
      .from('families')
      .select('id')
      .eq('id', family.id)
      .maybeSingle();

    if (!stillExists) {
      return {
        name,
        passed: false,
        detail:
          'anon deleted the family -- delete_family_cascade is exploitable',
      };
    }
    if (rpcError?.code !== '42501') {
      return {
        name,
        passed: false,
        detail: `family survived but call did not fail with permission-denied (42501); got ${rpcError?.code ?? 'no error'}`,
      };
    }
    return {
      name,
      passed: true,
      detail: 'anon call denied with permission-denied and the family survived',
    };
  } finally {
    await adminClient.rpc('delete_family_cascade', { p_family_id: family.id });
  }
}

// dequeue_processing_queue_item is SECURITY INVOKER and RLS-gated even if
// called, but the design intent is service_role-only -- assert the grant
// directly denies the call rather than relying on RLS as the only backstop.
async function probeDequeueProcessingQueueItem(
  _adminClient: DatabaseClient,
  anonClient: DatabaseClient,
): Promise<ScenarioResult> {
  const name = 'dequeue_processing_queue_item';
  const { error } = await anonClient.rpc('dequeue_processing_queue_item', {
    p_worker_id: 'privilege-probe-worker',
    p_lock_timeout_ms: 300000,
  });

  if (error?.code !== '42501') {
    return {
      name,
      passed: false,
      detail: `expected permission-denied (42501), got ${error?.code ?? 'no error'}`,
    };
  }
  return {
    name,
    passed: true,
    detail: 'anon call denied with permission-denied',
  };
}

function createDbClients(allowRemoteDb: boolean): {
  adminClient: DatabaseClient;
  anonClient: DatabaseClient;
} {
  const env = requireLiveDbEnv('Function privilege tests');
  assertLocalUnlessAllowed(env.url, allowRemoteDb);
  return {
    adminClient: createDatabaseClient(env),
    // No service role key -> anon-scoped, exactly what an unauthenticated
    // PostgREST caller would present.
    anonClient: createDatabaseClient({ url: env.url, anonKey: env.anonKey }),
  };
}

main().catch((err) => {
  console.error('Function privilege tests failed with error:', err);
  process.exit(1);
});
