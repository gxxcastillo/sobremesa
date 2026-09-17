/**
 * Import Routes
 *
 * Handles chat history import endpoints (WhatsApp is the only source with a
 * parser implemented today -- see `resolveImportSource` in
 * `libs/import-utils`, shared with `apps/cli`'s `sbm import` and
 * `ImportProcessor` so every import entry point resolves a source the same
 * way):
 * - POST /api/imports - Start import job (collection)
 * - POST /api/imports/check-duplicates - Check for duplicates (collection)
 * - GET /api/import/:jobId - Get job status (single resource)
 * - POST /api/import/:jobId/cancel - Cancel import
 * - POST /api/import/:jobId/resume - Resume failed import
 *
 * All routes require super_admin access.
 *
 * There is no pre-extraction review step: `runImportJob` chains
 * `ImportProcessor.processJob()` (parse + insert events) directly into
 * `runImportDrain()` (the shared Intern -> Scribe -> Registrar pipeline),
 * updating the job straight through to `complete`/`failed`. See
 * `.agents/plans/unified-import-pipeline-plan.md`.
 */

import { Elysia, t } from 'elysia';
import Anthropic from '@anthropic-ai/sdk';
import { loadAIConfig, createAIProviderFactory } from '@sobremesa/ai-provider';
import type { DatabaseClient } from '@sobremesa/database';
import {
  EventLogRepository,
  ProcessingQueueRepository,
} from '@sobremesa/database';
import {
  ImportJobRepository,
  ImportProcessor,
  runImportDrain,
} from '@sobremesa/import';
import { resolveImportSource } from '@sobremesa/import-utils';
import type {
  ImportConfig,
  ImportSource,
  ImportStatus,
  MessageFingerprint,
  DuplicateCheckResult,
} from '@sobremesa/shared-types';
import { requireSuperAdmin, getAuth } from '@sobremesa/auth';

/**
 * Import routes factory
 *
 * Every route in this file requires super admin access, so the guard is
 * applied once, to the whole file's Elysia instance.
 */
export function importRoutes(dbClient: DatabaseClient) {
  const jobRepo = new ImportJobRepository(dbClient);
  const eventLogRepo = new EventLogRepository(dbClient);
  const queueRepo = new ProcessingQueueRepository(dbClient);

  const getProcessor = () => {
    return new ImportProcessor({
      dbClient,
    });
  };

  // Built once at startup, reused across requests -- the extraction drain
  // makes real Intern/Scribe LLM calls, so it needs a real provider.
  const anthropicApiKey = process.env['ANTHROPIC_API_KEY'];
  const anthropicClient = anthropicApiKey
    ? new Anthropic({ apiKey: anthropicApiKey })
    : undefined;
  const aiConfig = loadAIConfig(
    process.env as Record<string, string | undefined>,
  );
  const aiFactory = createAIProviderFactory(aiConfig, anthropicClient);
  const hasAIProvider = aiConfig.defaultProvider !== 'mock';

  /**
   * Runs a job's full lifecycle: parse+insert (via `ImportProcessor`), then
   * -- once events are inserted and the job is in `'processing'` status --
   * the shared extraction drain, ending in `'complete'`/`'failed'`. Shared
   * by the initial `POST /api/imports` and `POST /api/import/:jobId/resume`
   * so both trigger the exact same automatic, no-manual-step pipeline.
   * Fire-and-forget from both callers; errors are logged by the caller's
   * own `.catch()` (mirroring `ImportProcessor.processJob()`'s existing
   * failure handling for the insert phase, which already marks the job
   * `'failed'` and logs `import_failed` itself before rethrowing).
   */
  async function runImportJob(jobId: string): Promise<void> {
    const processor = getProcessor();
    await processor.processJob(jobId);

    const job = await jobRepo.findById(jobId);
    if (!job || job.status !== 'processing') {
      // processJob() already handled (or short-circuited) a terminal
      // outcome -- cancelled mid-insert, or already complete/cancelled at
      // entry. Nothing left for this job to do.
      return;
    }

    const precondition =
      !job.familyId || !job.conversationId
        ? 'Job missing familyId or conversationId'
        : !hasAIProvider
          ? 'No AI provider configured (ANTHROPIC_API_KEY missing)'
          : null;
    if (precondition) {
      await jobRepo.update(jobId, { status: 'failed', error: precondition });
      return;
    }

    // Narrowed by the precondition check above (not by TS control-flow
    // analysis, since that check is expressed as a single ternary).
    const familyId = job.familyId as string;
    const conversationId = job.conversationId as string;

    try {
      const { total, processed, failed } = await runImportDrain({
        dbClient,
        queueRepo,
        jobId,
        familyId,
        conversationId,
        internProvider: aiFactory.getProviderForAgent('intern'),
        internModel: aiFactory.getModelForAgent('intern'),
        scribeProvider: aiFactory.getProviderForAgent('scribe'),
        scribeModel: aiFactory.getModelForAgent('scribe'),
        onProgress: async (current, progressTotal) => {
          await jobRepo.update(jobId, {
            progress: {
              current,
              total: progressTotal,
              stage: `Processing messages (${current}/${progressTotal})...`,
            },
          });
        },
      });

      // Atomic: only lands if the job is still 'processing'. If a
      // concurrent cancel already flipped it to 'cancelled', this is a
      // no-op rather than silently clobbering that cancellation back to
      // 'complete'.
      const completedJob = await jobRepo.transitionStatus(
        jobId,
        ['processing'],
        'complete',
        {
          current: total,
          total,
          stage:
            `Processed ${processed} messages` +
            (failed > 0 ? ` (${failed} failed)` : ''),
        },
        { completedAt: new Date() },
      );

      if (completedJob) {
        await eventLogRepo.log({
          familyId,
          eventType: 'import_completed',
          eventCategory: 'system_event',
          actor: 'system',
          actorType: 'system',
          severity: 'info',
          eventData: {
            importJobId: jobId,
            source: job.source,
            messagesProcessed: processed,
            messagesFailed: failed,
          },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      // Same atomic guard as the completion path above -- a concurrent
      // cancel must not be overwritten back to 'failed'.
      const failedJob = await jobRepo.transitionStatus(
        jobId,
        ['processing'],
        'failed',
        undefined,
        { error: message },
      );
      if (failedJob) {
        await eventLogRepo.log({
          familyId,
          eventType: 'import_failed',
          eventCategory: 'system_event',
          actor: 'system',
          actorType: 'system',
          severity: 'error',
          eventData: {
            importJobId: jobId,
            source: job.source,
            error: message,
            failedAt: 'extraction drain',
          },
        });
      }
      throw error;
    }
  }

  return (
    new Elysia()
      .use(requireSuperAdmin)
      /**
       * POST /api/imports/check-duplicates
       * Check how many messages already exist in the database
       */
      .post(
        '/api/imports/check-duplicates',
        async ({ body, set }) => {
          const { source, messages } = body as {
            source: ImportSource;
            messages: MessageFingerprint[];
          };

          if (!messages || messages.length === 0) {
            return {
              totalMessages: 0,
              alreadyExist: 0,
              newMessages: 0,
            } as DuplicateCheckResult;
          }

          try {
            // Helper to normalize timestamp to epoch ms for consistent comparison
            const toEpochMs = (ts: string | Date): number => {
              const d = typeof ts === 'string' ? new Date(ts) : ts;
              return d.getTime();
            };

            // Get date range from messages to query efficiently
            let minDate: Date | null = null;
            let maxDate: Date | null = null;

            for (const msg of messages) {
              const d = new Date(msg.occurredAt);
              if (!minDate || d < minDate) minDate = d;
              if (!maxDate || d > maxDate) maxDate = d;
            }

            if (!minDate || !maxDate) {
              return {
                totalMessages: messages.length,
                alreadyExist: 0,
                newMessages: messages.length,
              } as DuplicateCheckResult;
            }

            // Query all events in the date range (more reliable than exact timestamp matching)
            const { data: existingEvents, error } = await dbClient
              .from('conversation_events')
              .select(
                'occurred_at, actor_external_id, content_original, family_id',
              )
              .eq('source', source)
              .gte('occurred_at', minDate.toISOString())
              .lte('occurred_at', maxDate.toISOString());

            if (error) {
              throw new Error(`Database query failed: ${error.message}`);
            }

            // Build a set of existing message fingerprints for fast lookup
            // Use epoch ms + actor + content prefix as key for reliable matching
            const existingSet = new Set<string>();
            const existingEventsByKey = new Map<
              string,
              (typeof existingEvents)[0]
            >();

            for (const event of existingEvents || []) {
              const epochMs = toEpochMs(event.occurred_at);
              const key = `${epochMs}|${event.actor_external_id}|${(event.content_original || '').slice(0, 100)}`;
              existingSet.add(key);
              existingEventsByKey.set(key, event);
            }

            // Count matches
            let matchCount = 0;
            const familyMatches = new Map<string, number>();

            for (const msg of messages) {
              const epochMs = toEpochMs(msg.occurredAt);
              const key = `${epochMs}|${msg.actorRawName}|${msg.contentPrefix.slice(0, 100)}`;

              if (existingSet.has(key)) {
                matchCount++;

                // Track which family this belongs to
                const matchingEvent = existingEventsByKey.get(key);
                if (matchingEvent) {
                  const count = familyMatches.get(matchingEvent.family_id) || 0;
                  familyMatches.set(matchingEvent.family_id, count + 1);
                }
              }
            }

            // Find the family with most matches
            let existingFamilyId: string | undefined;
            let existingFamilyName: string | undefined;
            let maxMatches = 0;

            for (const [familyId, count] of familyMatches) {
              if (count > maxMatches) {
                maxMatches = count;
                existingFamilyId = familyId;
              }
            }

            // Get family name if we found matches
            if (existingFamilyId) {
              const { data: family } = await dbClient
                .from('families')
                .select('name')
                .eq('id', existingFamilyId)
                .single();
              existingFamilyName = family?.name;
            }

            return {
              totalMessages: messages.length,
              alreadyExist: matchCount,
              newMessages: messages.length - matchCount,
              existingFamilyId,
              existingFamilyName,
            } as DuplicateCheckResult;
          } catch (error) {
            console.error('Duplicate check failed:', error);
            set.status = 500;
            return {
              error: `Duplicate check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
            };
          }
        },
        {
          body: t.Object({
            source: t.Union([
              t.Literal('whatsapp'),
              t.Literal('telegram'),
              t.Literal('other'),
            ]),
            messages: t.Array(
              t.Object({
                occurredAt: t.Union([t.String(), t.Date()]),
                actorRawName: t.String(),
                contentPrefix: t.String(),
              }),
            ),
          }),
          detail: {
            tags: ['Import'],
            description:
              'Check how many messages already exist in the database (super admin only)',
          },
        },
      )
      /**
       * POST /api/imports
       * Start a new import job
       */
      .post(
        '/api/imports',
        async (ctx) => {
          const { body, set } = ctx;
          const auth = getAuth(ctx);
          // requireSuperAdmin already guarantees this at runtime; narrow the
          // type here since Elysia doesn't carry that across the guard.
          if (!auth.identity) {
            set.status = 401;
            return { error: 'Authentication required' };
          }

          const file = body.file;

          // Reject files over 50 MB to prevent OOM and DB bloat
          const MAX_FILE_SIZE = 50 * 1024 * 1024;
          if (file.size > MAX_FILE_SIZE) {
            set.status = 413;
            return {
              error: `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 50 MB.`,
            };
          }

          let config: ImportConfig;
          try {
            config = JSON.parse(body.config);
          } catch {
            set.status = 400;
            return { error: 'Invalid config JSON' };
          }

          // Read file content
          const fileContent = await file.text();
          if (!fileContent.trim()) {
            set.status = 400;
            return { error: 'Empty file' };
          }

          if (!config.family?.name) {
            set.status = 400;
            return { error: 'Family name is required' };
          }

          // `source` picks a parser explicitly, or it's auto-detected --
          // same resolution `sbm import` and `ImportProcessor` use, so a
          // client can name a future format (or omit it) without this route
          // assuming WhatsApp.
          let source: ImportSource;
          try {
            source = resolveImportSource(fileContent, body.source).source;
          } catch (error) {
            set.status = 400;
            return {
              error: error instanceof Error ? error.message : String(error),
            };
          }

          try {
            // Create import job with raw file content
            const job = await jobRepo.create({
              createdBy: auth.identity.id,
              source,
              config,
              rawFileContent: fileContent,
              messageCount: 0, // processor will determine actual count
            });

            // Start processing (insert events, then the extraction drain)
            // in the background.
            runImportJob(job.id).catch((error) => {
              console.error('Import job failed:', error);
            });

            return { jobId: job.id };
          } catch (error) {
            console.error('Failed to start import:', error);
            set.status = 500;
            return {
              error: `Failed to start import: ${error instanceof Error ? error.message : 'Unknown error'}`,
            };
          }
        },
        {
          body: t.Object({
            file: t.File(),
            config: t.String(), // JSON string of ImportConfig
            // Optional: auto-detected from the file when omitted (see
            // `resolveImportSource` above). 'telegram'/'other' are
            // recognized but have no parser yet, so requesting one fails
            // with a 400 rather than being silently treated as WhatsApp.
            source: t.Optional(
              t.Union([
                t.Literal('whatsapp'),
                t.Literal('telegram'),
                t.Literal('other'),
              ]),
            ),
          }),
          detail: {
            tags: ['Import'],
            description: 'Start a chat import job (super admin only)',
          },
        },
      )
      /**
       * GET /api/import/:jobId
       * Get import job status
       */
      .get(
        '/api/import/:jobId',
        async ({ params: { jobId }, set }) => {
          const job = await jobRepo.findById(jobId);
          if (!job) {
            set.status = 404;
            return { error: 'Import job not found' };
          }

          const status: ImportStatus = {
            jobId: job.id,
            status: job.status,
            progress: {
              current: job.progress?.current || 0,
              total: job.progress?.total || 0,
              percentage:
                job.progress?.total > 0
                  ? Math.round(
                      (job.progress.current / job.progress.total) * 100,
                    )
                  : 0,
            },
            stage: job.progress?.stage || 'Unknown',
            batchId: job.batchIds[0],
            familyId: job.familyId,
            error: job.error,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
          };

          return status;
        },
        {
          params: t.Object({ jobId: t.String() }),
          detail: {
            tags: ['Import'],
            description: 'Get import job status (super admin only)',
          },
        },
      )
      /**
       * POST /api/import/:jobId/cancel
       * Cancel an in-progress import
       */
      .post(
        '/api/import/:jobId/cancel',
        async (ctx) => {
          const {
            params: { jobId },
            set,
          } = ctx;
          const auth = getAuth(ctx);

          const job = await jobRepo.findById(jobId);
          if (!job) {
            set.status = 404;
            return { error: 'Import job not found' };
          }

          if (job.status === 'complete' || job.status === 'cancelled') {
            set.status = 400;
            return {
              error: 'Cannot cancel a completed or already cancelled job',
            };
          }

          // Compare-and-swap: only cancel if the job is still in a
          // non-terminal status. This avoids a race where the drain
          // transitions the job to 'complete'/'failed' between our read
          // above and this write, which would otherwise silently clobber
          // a finished job's status back to 'cancelled'.
          const updated = await jobRepo.transitionStatus(
            jobId,
            [
              'pending',
              'creating_family',
              'creating_identities',
              'submitting',
              'processing',
              'hydrating',
            ],
            'cancelled',
            undefined,
            { error: 'Cancelled by user' },
          );

          if (!updated) {
            set.status = 400;
            return {
              error: 'Cannot cancel a completed or already cancelled job',
            };
          }

          // Log cancellation event
          if (job.familyId) {
            await eventLogRepo.log({
              familyId: job.familyId,
              eventType: 'import_cancelled',
              eventCategory: 'system_event',
              actor: auth.identity?.displayName || 'super_admin',
              actorType: 'user',
              severity: 'warning',
              eventData: {
                importJobId: jobId,
                source: job.source,
                cancelledAt: job.progress?.stage || 'unknown',
                messagesProcessed: job.progress?.current || 0,
              },
            });
          }

          return { success: true };
        },
        {
          params: t.Object({ jobId: t.String() }),
          detail: {
            tags: ['Import'],
            description: 'Cancel an in-progress import (super admin only)',
          },
        },
      )
      /**
       * POST /api/import/:jobId/resume
       * Resume a failed import from checkpoint
       */
      .post(
        '/api/import/:jobId/resume',
        async ({ params: { jobId }, set }) => {
          const job = await jobRepo.findById(jobId);
          if (!job) {
            set.status = 404;
            return { error: 'Import job not found' };
          }

          if (job.status !== 'failed') {
            set.status = 400;
            return { error: 'Can only resume failed jobs' };
          }

          // Compare-and-swap, mirroring /cancel above: only resume if the
          // job is still 'failed'. Without this, two overlapping resume
          // calls (double-click, retry, a second admin) could both pass the
          // read above, both flip status to 'pending', and both invoke
          // runImportJob concurrently for the same job/family -- racing two
          // Intern->Scribe->Registrar drains and letting one's failure
          // handler clobber the other's in-progress/complete status.
          const updated = await jobRepo.transitionStatus(
            jobId,
            ['failed'],
            'pending',
            undefined,
            { error: undefined },
          );

          if (!updated) {
            set.status = 400;
            return { error: 'Can only resume failed jobs' };
          }

          // Start processing in background
          runImportJob(jobId).catch((error) => {
            console.error('Import job failed:', error);
          });

          return { success: true };
        },
        {
          params: t.Object({ jobId: t.String() }),
          detail: {
            tags: ['Import'],
            description: 'Resume a failed import job (super admin only)',
          },
        },
      )
  );
}
