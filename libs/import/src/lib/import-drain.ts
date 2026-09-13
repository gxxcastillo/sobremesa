/**
 * The unified import drain: every imported event runs through the exact
 * same shared Intern -> Scribe -> Registrar pipeline live chat uses --
 * `buildMessagePipeline({ stages: ['router', 'filter', 'imageLinker',
 * 'scribe', 'registrar'] })` -- with no pre-extraction human review
 * checkpoint. `'admin'`, `'historian'`, and `'facilitatorNudge'` are
 * deliberately never wired: a historical import must never send an
 * outbound message or answer a question. See
 * `.agents/plans/unified-import-pipeline-plan.md` and the ADR it names.
 *
 * Replaces the old two-phase `runInternTriage`/`runExtractionDrain` split
 * (and the `intern_decisions` table they wrote into -- see git history of
 * this file, formerly `intern-triage.ts`).
 *
 * Processes a bounded, known set of event ids for one import job directly
 * (`processor.process(eventId, familyId)`), never via `dequeueAny()` -- it
 * doesn't compete with the live poller for unrelated rows. Each event still
 * gets a `processing_queue` row (via `enqueue()`, tagged `intent: 'import'`)
 * for bookkeeping/observability; the live poller's own `intentFilter`
 * (`['live']`, see `apps/chatbots/src/main.ts`) excludes 'import' rows
 * outright, so it can never claim one mid-drain.
 *
 * Shared between the Studio import wizard (`apps/api/src/routes/import.ts`,
 * triggered automatically once `ImportProcessor` finishes inserting events)
 * and available to `apps/cli` for parity, though `sbm import`/`sbm process`
 * today drive the same stage set directly through the live-intent queue
 * (see `pipeline-cli-plan.md`) since local dev has no separate job
 * lifecycle to chain this from.
 */

import type { AIProvider } from '@sobremesa/ai-provider';
import { buildMessagePipeline, type PipelineStage } from '@sobremesa/pipeline';
import {
  ConversationEventRepository,
  type DatabaseClient,
  type ProcessingQueueRepository,
} from '@sobremesa/database';
import type { QueueItem } from '@sobremesa/shared-types';
import { ImportJobRepository } from './import-job-repository';

/** Progress callback -- fired after each event finishes. */
export type DrainProgressCallback = (
  processed: number,
  total: number,
) => Promise<void> | void;

export interface ImportDrainOptions {
  dbClient: DatabaseClient;
  queueRepo: ProcessingQueueRepository;
  /** Checked periodically so a cancel mid-drain stops further processing. */
  jobId: string;
  familyId: string;
  conversationId: string;
  internProvider: AIProvider;
  internModel: string;
  scribeProvider: AIProvider;
  scribeModel: string;
  onProgress?: DrainProgressCallback;
}

export interface ImportDrainResult {
  total: number;
  processed: number;
  failed: number;
}

const IMPORT_PIPELINE_STAGES: PipelineStage[] = [
  'router',
  'filter',
  'imageLinker',
  'scribe',
  'registrar',
];

/**
 * Drains every event in `conversationId` through the shared import
 * pipeline. Enqueues each id with `intent: 'import'` first (bookkeeping/
 * observability), then processes them directly in order. A per-event
 * failure is tracked, not fatal -- the drain continues through the rest of
 * the known set, matching `sbm process`'s own established resilience
 * pattern.
 */
export async function runImportDrain(
  options: ImportDrainOptions,
): Promise<ImportDrainResult> {
  const {
    dbClient,
    queueRepo,
    jobId,
    familyId,
    conversationId,
    internProvider,
    internModel,
    scribeProvider,
    scribeModel,
    onProgress,
  } = options;

  const jobRepo = new ImportJobRepository(dbClient);

  const eventIds = await new ConversationEventRepository(
    dbClient,
  ).findAllIdsInConversation(familyId, conversationId);

  const processor = buildMessagePipeline({
    dbClient,
    stages: new Set<PipelineStage>(IMPORT_PIPELINE_STAGES),
    providers: { intern: internProvider, scribe: scribeProvider },
    models: { intern: internModel, scribe: scribeModel },
  });

  // enqueue() returns the existing row (status untouched) when one already
  // exists for this event -- e.g. a resumed job re-running this same drain.
  // Keep that returned row instead of discarding it and re-fetching it with
  // a second query per event below.
  //
  // This is pure bookkeeping (each row is independent, and the processing
  // loop below iterates `eventIds` in its own fixed order regardless of
  // which enqueue lands first), so it's safe to fan these out in bounded
  // batches instead of one round trip at a time -- for a large import this
  // is otherwise minutes of dead time before any real processing starts.
  const ENQUEUE_BATCH_SIZE = 25;
  const queueItemsByEventId = new Map<string, QueueItem>();
  for (let i = 0; i < eventIds.length; i += ENQUEUE_BATCH_SIZE) {
    const batch = eventIds.slice(i, i + ENQUEUE_BATCH_SIZE);
    const queueItems = await Promise.all(
      batch.map((eventId) =>
        queueRepo.enqueue(familyId, eventId, { intent: 'import' }),
      ),
    );
    batch.forEach((eventId, index) =>
      queueItemsByEventId.set(eventId, queueItems[index]),
    );
  }

  // Progress is persisted via a DB write per call -- report it on every
  // event's completion, but throttle how often that actually happens so a
  // large import doesn't issue one `import_jobs` UPDATE per message.
  const progressReportInterval = 10;
  const reportProgress = async (processed: number, failed: number) => {
    if (!onProgress) return;
    const count = processed + failed;
    if (count === eventIds.length || count % progressReportInterval === 0) {
      await onProgress(count, eventIds.length);
    }
  };

  let processed = 0;
  let failed = 0;
  for (const eventId of eventIds) {
    const queueItem = queueItemsByEventId.get(eventId);

    if (queueItem?.status === 'done') {
      // Already completed by an earlier pass (e.g. this job was resumed
      // after a partial failure) -- skip rather than reprocess. Scribe/
      // Registrar are not idempotent on a repeat pass (claims are never
      // deduplicated, only entities are), so reprocessing an already-'done'
      // event would duplicate extracted data.
      processed++;
      await reportProgress(processed, failed);
      continue;
    }

    const result = await processor.process(eventId, familyId);

    if (queueItem) {
      if (result.success) {
        await queueRepo.complete(familyId, queueItem.id);
      } else {
        await queueRepo.fail(
          familyId,
          queueItem.id,
          result.error || 'Unknown error',
          3,
        );
      }
    }

    if (result.success) {
      processed++;
    } else {
      failed++;
    }
    await reportProgress(processed, failed);

    // Check for cancellation on the same throttled cadence as progress
    // reporting -- one extra read per ~10 events, not one per event -- so a
    // cancel mid-drain stops further Scribe/Registrar writes within a bounded
    // window instead of running to completion regardless. The final status
    // write in the caller (`apps/api/src/routes/import.ts`) is itself an
    // atomic transition guarded on the job still being 'processing', so it
    // never clobbers a 'cancelled' status even if a cancel lands in the gap
    // between checks here.
    const count = processed + failed;
    if (count % progressReportInterval === 0) {
      const job = await jobRepo.findById(jobId);
      if (job?.status === 'cancelled') {
        break;
      }
    }
  }

  return { total: eventIds.length, processed, failed };
}
