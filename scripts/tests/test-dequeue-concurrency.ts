#!/usr/bin/env bun
/**
 * Live-DB integration tests for dequeue_processing_queue_item's per-family
 * serialization (.agents/extraction-hardening-plan.md item C). The invariant
 * ("one in-flight processing_queue row per family") only shows up under real
 * concurrent Postgres transactions, so this drives the actual RPC against a
 * running local Supabase instance instead of asserting RPC-call parameters
 * against a mock. Manual only -- not part of test:all/CI: no live-DB test of
 * any kind (including the Tier-2 pipeline-snapshot runner) runs in CI today,
 * since no CI infra spins up a local Supabase instance yet (AGENTS.md itself
 * says nothing on this; the only written CI-exclusion rule, in
 * spec/ai-providers-and-prompts.md, is specifically about live LLM evals).
 * Wiring this into CI is open work -- see .agents/extraction-hardening-plan.md
 * item C's 2026-07-08 residual note. Requires `bun nx run db:start` first, and
 * assumes an otherwise-idle local queue (same assumption as
 * scripts/process-one.ts and scripts/tests/test-consolidated-welcome.ts) --
 * if a scenario fails unexpectedly, try `bun nx run db:reset` first.
 *
 * Run with: bun scripts/tests/test-dequeue-concurrency.ts
 */
import 'dotenv/config';
import { ConversationEventRepository } from '../../libs/database/src/lib/repositories/conversation-event-repository.js';
import { ProcessingQueueRepository } from '../../libs/database/src/lib/repositories/processing-queue-repository.js';
import { QueuePriority } from '../../libs/shared/types/src/lib/queue.js';
import type { QueuePriorityLevel } from '../../libs/shared/types/src/lib/queue.js';
import type { DatabaseClient } from '../../libs/database/src/lib/client.js';
import {
  createLiveDbClient,
  randomSuffix,
  runScenarios,
  type ScenarioResult,
} from './live-db-test-utils.js';

const RACE_ITERATIONS = 25;

async function main(): Promise<void> {
  const allowRemoteDb = process.argv.includes('--allow-remote-db');
  const client = createLiveDbClient('Dequeue concurrency tests', allowRemoteDb);
  await warnIfQueueNotIdle(client);

  const scenarioFns: Array<
    (client: DatabaseClient) => Promise<ScenarioResult>
  > = [
    scenarioNoDoubleLeaseUnderConcurrency,
    scenarioStaleRowNotStarvedByOtherFamilies,
    scenarioStaleRowPrecedesNewerQueuedRowSameFamily,
    scenarioDifferentFamiliesLeaseConcurrently,
  ];

  await runScenarios(
    scenarioFns.map((scenario) => ({
      name: scenario.name,
      run: () => scenario(client),
    })),
    {
      allPassed: 'All dequeue concurrency scenarios passed.',
      someFailed: (count) => `${count} scenario(s) failed.`,
    },
  );
}

// --- Scenario 1: the core regression from finding #1 -- two concurrent ---
// --- dequeues for a family with two ready rows must never both lease.   ---
async function scenarioNoDoubleLeaseUnderConcurrency(
  client: DatabaseClient,
): Promise<ScenarioResult> {
  const name = 'no-double-lease-under-concurrency';
  const queueRepo = new ProcessingQueueRepository(client);
  const family = await createFamily(client, 'dequeue-race');
  try {
    for (let i = 0; i < RACE_ITERATIONS; i++) {
      const eventA = await insertEvent(client, family.id, `race-${i}-a`);
      const eventB = await insertEvent(client, family.id, `race-${i}-b`);
      await enqueueReady(client, family.id, eventA, {
        priority: QueuePriority.NORMAL,
      });
      await enqueueReady(client, family.id, eventB, {
        priority: QueuePriority.NORMAL,
      });

      await Promise.all([
        queueRepo.dequeueAny('racer-1'),
        queueRepo.dequeueAny('racer-2'),
      ]);

      const rows = await getFamilyQueueRows(client, family.id);
      const processingCount = rows.filter(
        (r) => r.status === 'processing',
      ).length;
      if (processingCount !== 1) {
        return {
          name,
          passed: false,
          detail: `iteration ${i}: expected exactly 1 processing row for the family, got ${processingCount}`,
        };
      }
      // Reset for the next iteration regardless of current status.
      await queueRepo.completeMany(
        family.id,
        rows.map((r) => r.id),
      );
    }
    return {
      name,
      passed: true,
      detail: `exactly one lease held across ${RACE_ITERATIONS} concurrent-pair iterations`,
    };
  } finally {
    await deleteFamily(client, family.id);
  }
}

// --- Scenario 2: starvation regression from finding #2 -- a family's ---
// --- stale item must not wait for every other family's queue to empty. ---
async function scenarioStaleRowNotStarvedByOtherFamilies(
  client: DatabaseClient,
): Promise<ScenarioResult> {
  const name = 'stale-row-not-starved-by-other-families';
  const queueRepo = new ProcessingQueueRepository(client);
  const staleFamily = await createFamily(client, 'dequeue-starved');
  const busyFamily = await createFamily(client, 'dequeue-busy');
  try {
    const staleEvent = await insertEvent(client, staleFamily.id, 'stale-1');
    await enqueueStaleProcessing(client, staleFamily.id, staleEvent, {
      priority: QueuePriority.NORMAL,
      queuedAt: minutesAgo(20),
      lockedAt: minutesAgo(20),
    });

    const busyEvent = await insertEvent(client, busyFamily.id, 'busy-1');
    await enqueueReady(client, busyFamily.id, busyEvent, {
      priority: QueuePriority.NORMAL,
    });

    const leased = await queueRepo.dequeueAny('recovery-worker');

    if (!leased || leased.familyId !== staleFamily.id) {
      return {
        name,
        passed: false,
        detail: `expected the stale family's item to be reclaimed first, got ${
          leased ? `family ${leased.familyId}` : 'nothing'
        }`,
      };
    }

    const busyRows = await getFamilyQueueRows(client, busyFamily.id);
    if (busyRows[0]?.status !== 'queued') {
      return {
        name,
        passed: false,
        detail: `expected the other family's item to remain queued, was ${busyRows[0]?.status}`,
      };
    }

    return {
      name,
      passed: true,
      detail:
        "stale family's item reclaimed while another family had ready work",
    };
  } finally {
    await deleteFamily(client, staleFamily.id);
    await deleteFamily(client, busyFamily.id);
  }
}

// --- Scenario 3: per-family ordering from finding #2/#4 -- a family's ---
// --- own stale item precedes its newer queued item regardless of      ---
// --- priority (per-family order beats global priority).               ---
async function scenarioStaleRowPrecedesNewerQueuedRowSameFamily(
  client: DatabaseClient,
): Promise<ScenarioResult> {
  const name = 'stale-row-precedes-newer-queued-row-same-family';
  const queueRepo = new ProcessingQueueRepository(client);
  const family = await createFamily(client, 'dequeue-order');
  try {
    const staleEvent = await insertEvent(client, family.id, 'order-stale');
    await enqueueStaleProcessing(client, family.id, staleEvent, {
      priority: QueuePriority.NORMAL,
      queuedAt: minutesAgo(20),
      lockedAt: minutesAgo(20),
    });

    // A newer, more urgent item for the SAME family -- must not preempt
    // the interrupted item.
    const newEvent = await insertEvent(client, family.id, 'order-new');
    await enqueueReady(client, family.id, newEvent, {
      priority: QueuePriority.CRITICAL,
    });

    const leased = await queueRepo.dequeueAny('order-worker');

    if (!leased || leased.conversationEventId !== staleEvent) {
      return {
        name,
        passed: false,
        detail: `expected the stale (older) row to lease first regardless of priority, got conversationEventId=${leased?.conversationEventId}`,
      };
    }

    return {
      name,
      passed: true,
      detail:
        "family's stale row leased ahead of its own higher-priority newer row",
    };
  } finally {
    await deleteFamily(client, family.id);
  }
}

// --- Scenario 4: the fix must not over-serialize -- unrelated families ---
// --- lease concurrently without blocking each other.                   ---
async function scenarioDifferentFamiliesLeaseConcurrently(
  client: DatabaseClient,
): Promise<ScenarioResult> {
  const name = 'different-families-lease-concurrently';
  const queueRepo = new ProcessingQueueRepository(client);
  const familyF = await createFamily(client, 'dequeue-f');
  const familyG = await createFamily(client, 'dequeue-g');
  try {
    const eventF = await insertEvent(client, familyF.id, 'cross-f');
    await enqueueReady(client, familyF.id, eventF, {
      priority: QueuePriority.NORMAL,
    });
    const eventG = await insertEvent(client, familyG.id, 'cross-g');
    await enqueueReady(client, familyG.id, eventG, {
      priority: QueuePriority.NORMAL,
    });

    const [r1, r2] = await Promise.all([
      queueRepo.dequeueAny('cross-worker-1'),
      queueRepo.dequeueAny('cross-worker-2'),
    ]);

    const leasedFamilies = new Set([r1?.familyId, r2?.familyId]);
    if (
      !r1 ||
      !r2 ||
      !leasedFamilies.has(familyF.id) ||
      !leasedFamilies.has(familyG.id)
    ) {
      return {
        name,
        passed: false,
        detail: `expected both families to lease concurrently, got ${r1?.familyId ?? 'null'} / ${r2?.familyId ?? 'null'}`,
      };
    }

    return {
      name,
      passed: true,
      detail: 'two unrelated families both leased in the same concurrent round',
    };
  } finally {
    await deleteFamily(client, familyF.id);
    await deleteFamily(client, familyG.id);
  }
}

// --- Fixtures ---

async function warnIfQueueNotIdle(client: DatabaseClient): Promise<void> {
  const { count, error } = await client
    .from('processing_queue')
    .select('*', { count: 'exact', head: true })
    .in('status', ['queued', 'processing']);
  if (!error && count) {
    console.log(
      `Warning: ${count} pre-existing queued/processing row(s) found. Scenarios assume an idle ` +
        'queue and may give false failures; consider `bun nx run db:reset` first.\n',
    );
  }
}

async function createFamily(
  client: DatabaseClient,
  label: string,
): Promise<{ id: string }> {
  const { data, error } = await client
    .from('families')
    .insert({
      name: `Dequeue Concurrency | ${label}`,
      chat_source: 'telegram',
      chat_id: `dequeue-concurrency-${label}-${randomSuffix()}`,
      config: {},
    })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(`Failed to create test family: ${error?.message}`);
  }
  return { id: String(data.id) };
}

async function deleteFamily(
  client: DatabaseClient,
  familyId: string,
): Promise<void> {
  const { error } = await client.rpc('delete_family_cascade', {
    p_family_id: familyId,
  });
  if (error) {
    throw new Error(
      `Failed to delete test family ${familyId}: ${error.message}`,
    );
  }
}

async function insertEvent(
  client: DatabaseClient,
  familyId: string,
  externalEventId: string,
): Promise<string> {
  const occurredAt = new Date();
  const event = await new ConversationEventRepository(client).insert({
    familyId,
    source: 'telegram',
    conversationId: 'dequeue-concurrency-chat',
    externalEventId: `${externalEventId}-${randomSuffix()}`,
    actorExternalId: 'dequeue-concurrency-tester',
    actorDisplayName: 'Tester',
    eventType: 'message',
    contentOriginal: 'dequeue concurrency fixture',
    languageOriginal: 'unknown',
    metadata: {},
    sourcePayload: {},
    occurredAt,
    ingestedAt: occurredAt,
  });
  return event.id;
}

async function enqueueReady(
  client: DatabaseClient,
  familyId: string,
  conversationEventId: string,
  options: { priority: QueuePriorityLevel },
): Promise<void> {
  await new ProcessingQueueRepository(client).enqueue(
    familyId,
    conversationEventId,
    { priority: options.priority },
  );
}

async function enqueueStaleProcessing(
  client: DatabaseClient,
  familyId: string,
  conversationEventId: string,
  options: { priority: QueuePriorityLevel; queuedAt: Date; lockedAt: Date },
): Promise<void> {
  const { error } = await client.from('processing_queue').insert({
    family_id: familyId,
    conversation_event_id: conversationEventId,
    status: 'processing',
    attempts: 1,
    priority: options.priority,
    process_after: options.queuedAt.toISOString(),
    queued_at: options.queuedAt.toISOString(),
    locked_at: options.lockedAt.toISOString(),
    locked_by: 'dead-worker',
  });
  if (error) {
    throw new Error(
      `Failed to enqueue stale-processing fixture row: ${error.message}`,
    );
  }
}

async function getFamilyQueueRows(
  client: DatabaseClient,
  familyId: string,
): Promise<Array<{ id: string; status: string }>> {
  const { data, error } = await client
    .from('processing_queue')
    .select('id, status')
    .eq('family_id', familyId);
  if (error) {
    throw new Error(`Failed to read fixture rows: ${error.message}`);
  }
  return data ?? [];
}

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60 * 1000);
}

main().catch((err) => {
  console.error('Dequeue concurrency tests failed with error:', err);
  process.exit(1);
});
