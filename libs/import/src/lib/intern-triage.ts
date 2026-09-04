/**
 * The real two-phase import drain, replacing the old heuristic-only
 * `classifyAndRecordDecisions`/`enqueueProcessDecisions` (see git history
 * of `intern-classification.ts`, deleted alongside this file landing --
 * see `.agents/plans/import-filter-convergence-plan.md`).
 *
 * Both phases process a bounded, known set of event ids for one import
 * job directly (`processor.process(eventId, familyId)`), never via
 * `dequeueAny()` -- they don't compete with the live poller (or each
 * other) for unrelated rows. Each phase still writes a `processing_queue`
 * row per event (via `enqueue()`, tagged with the phase's own `intent`) so
 * the row exists for bookkeeping/observability. The live poller's own
 * `intentFilter` (`['live']`, see `apps/chatbots/src/main.ts`) excludes
 * both `'triage'` and `'extract'` rows outright, so it can never claim
 * either phase's row while a drain here is using it.
 *
 * Shared between the Studio import wizard's `run-intern`/`submit-scribe`
 * routes (`apps/api/src/routes/import.ts`) and `sbm import`/`sbm process`
 * (`apps/cli`), so every import entry point drives the exact same drains.
 */

import type { AIProvider } from '@sobremesa/ai-provider';
import { buildMessagePipeline, type PipelineStage } from '@sobremesa/pipeline';
import {
  ConversationEventRepository,
  type DatabaseClient,
  type ProcessingQueueRepository,
} from '@sobremesa/database';
import type { MessageProcessor } from '@sobremesa/queue';
import type { QueueIntent } from '@sobremesa/shared-types';
import type { InternDecisionRepository } from './intern-decision-repository';

/** Progress callback shared by both drains -- fired after each event finishes. */
export type DrainProgressCallback = (
  processed: number,
  total: number,
) => Promise<void> | void;

interface ScopedDrainOptions {
  queueRepo: ProcessingQueueRepository;
  familyId: string;
  eventIds: string[];
  intent: QueueIntent;
  processor: MessageProcessor;
  onProgress?: DrainProgressCallback;
}

interface ScopedDrainResult {
  total: number;
  processed: number;
  failed: number;
}

/**
 * Enqueues every id in `eventIds` with `intent`, then drains them directly
 * (bounded, known set -- no `dequeueAny()`), completing/failing each one's
 * own queue row as it finishes. A per-event failure is tracked, not fatal --
 * the drain continues through the rest of the known set, matching `sbm
 * process`'s own established resilience pattern.
 */
async function drainScoped(
  options: ScopedDrainOptions,
): Promise<ScopedDrainResult> {
  const { queueRepo, familyId, eventIds, intent, processor, onProgress } =
    options;

  for (const eventId of eventIds) {
    await queueRepo.enqueue(familyId, eventId, { intent });
  }

  let processed = 0;
  let failed = 0;
  for (const eventId of eventIds) {
    const queueItem = await queueRepo.findByEventId(familyId, eventId);
    const result = await processor.process(eventId, familyId);

    if (queueItem) {
      if (result.success) {
        await queueRepo.complete(familyId, queueItem.id);
      } else {
        await queueRepo.fail(
          familyId,
          queueItem.id,
          result.error || 'Unknown error',
        );
      }
    }

    if (result.success) {
      processed++;
    } else {
      failed++;
    }
    if (onProgress) {
      await onProgress(processed + failed, eventIds.length);
    }
  }

  return { total: eventIds.length, processed, failed };
}

export interface InternTriageOptions {
  dbClient: DatabaseClient;
  decisionRepo: InternDecisionRepository;
  queueRepo: ProcessingQueueRepository;
  familyId: string;
  importJobId: string;
  conversationId: string;
  internProvider: AIProvider;
  internModel: string;
  onProgress?: DrainProgressCallback;
}

export interface InternTriageResult {
  total: number;
  processed: number;
  failed: number;
  counts: { toProcess: number; toSkip: number; overridden: number };
}

/**
 * Phase 1 (triage): drains every event in `conversationId` through Intern's
 * real router+filter (`stages: ['router', 'filter']` only -- no Scribe, no
 * Registrar cost). `onFilterDecision` records every real verdict into
 * `intern_decisions`, replacing the old heuristic's guess.
 */
export async function runInternTriage(
  options: InternTriageOptions,
): Promise<InternTriageResult> {
  const {
    dbClient,
    decisionRepo,
    queueRepo,
    familyId,
    importJobId,
    conversationId,
    internProvider,
    internModel,
    onProgress,
  } = options;

  const eventIds = await new ConversationEventRepository(
    dbClient,
  ).findAllIdsInConversation(familyId, conversationId);

  const processor = buildMessagePipeline({
    dbClient,
    stages: new Set<PipelineStage>(['router', 'filter']),
    providers: { intern: internProvider },
    models: { intern: internModel },
    onFilterDecision: async (eventId, decisionFamilyId, result) => {
      await decisionRepo.upsert(
        decisionFamilyId,
        importJobId,
        eventId,
        result.relevant ? 'process' : 'skip',
        result.reason,
      );
    },
  });

  const { total, processed, failed } = await drainScoped({
    queueRepo,
    familyId,
    eventIds,
    intent: 'triage',
    processor,
    onProgress,
  });

  const counts = await decisionRepo.getCounts(importJobId);
  return { total, processed, failed, counts };
}

export interface ExtractionDrainOptions {
  dbClient: DatabaseClient;
  queueRepo: ProcessingQueueRepository;
  familyId: string;
  eventIds: string[];
  scribeProvider: AIProvider;
  scribeModel: string;
  onProgress?: DrainProgressCallback;
}

export interface ExtractionDrainResult {
  total: number;
  processed: number;
  failed: number;
}

/**
 * Phase 2 (extraction): drains the human-approved event ids through
 * Scribe/Registrar only (`stages: ['scribe', 'registrar']`). `'filter'` is
 * deliberately excluded -- `shouldProcess` defaults `true` with no filter
 * wired (`processTextContent`), so re-running it here would both double-pay
 * for the same judgment and risk silently overriding a human's override.
 */
export async function runExtractionDrain(
  options: ExtractionDrainOptions,
): Promise<ExtractionDrainResult> {
  const {
    dbClient,
    queueRepo,
    familyId,
    eventIds,
    scribeProvider,
    scribeModel,
    onProgress,
  } = options;

  const processor = buildMessagePipeline({
    dbClient,
    stages: new Set<PipelineStage>(['scribe', 'registrar']),
    providers: { scribe: scribeProvider },
    models: { scribe: scribeModel },
  });

  return drainScoped({
    queueRepo,
    familyId,
    eventIds,
    intent: 'extract',
    processor,
    onProgress,
  });
}
