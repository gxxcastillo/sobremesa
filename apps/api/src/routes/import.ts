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
  InternDecisionRepository,
  runInternTriage,
  runExtractionDrain,
} from '@sobremesa/import';
import { resolveImportSource } from '@sobremesa/import-utils';
import type {
  ImportConfig,
  ImportSource,
  ImportStatus,
  MessageWithDecision,
  InternDecisionType,
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
  const decisionRepo = new InternDecisionRepository(dbClient);
  const queueRepo = new ProcessingQueueRepository(dbClient);

  const getProcessor = () => {
    return new ImportProcessor({
      dbClient,
    });
  };

  // Built once at startup, reused across requests -- `run-intern` and
  // `submit-scribe` now make real Intern/Scribe LLM calls (the whole point
  // of this file's rewire, see import-filter-convergence-plan.md) instead
  // of a free heuristic guess, so both need a real provider.
  const anthropicApiKey = process.env['ANTHROPIC_API_KEY'];
  const anthropicClient = anthropicApiKey
    ? new Anthropic({ apiKey: anthropicApiKey })
    : undefined;
  const aiConfig = loadAIConfig(
    process.env as Record<string, string | undefined>,
  );
  const aiFactory = createAIProviderFactory(aiConfig, anthropicClient);
  const hasAIProvider = aiConfig.defaultProvider !== 'mock';

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

            // Start processing in background
            const processor = getProcessor();
            // Don't await - let it run in background
            processor.processJob(job.id).catch((error) => {
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

          await jobRepo.update(jobId, {
            status: 'cancelled',
            error: 'Cancelled by user',
          });

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

          // Reset status to pending
          await jobRepo.update(jobId, {
            status: 'pending',
            error: undefined,
          });

          // Start processing in background
          const processor = getProcessor();
          processor.processJob(jobId).catch((error) => {
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
      /**
       * POST /api/import/:jobId/run-intern
       * Run Intern classification on all messages for a job
       */
      .post(
        '/api/import/:jobId/run-intern',
        async ({ params: { jobId }, set }) => {
          // Atomically transition to running_intern — prevents two concurrent
          // calls from both proceeding past this point.
          const job = await jobRepo.transitionStatus(
            jobId,
            ['awaiting_intern', 'intern_complete'],
            'running_intern',
          );

          if (!job) {
            // Either the job doesn't exist or it wasn't in an expected status
            const existing = await jobRepo.findById(jobId);
            if (!existing) {
              set.status = 404;
              return { error: 'Import job not found' };
            }
            set.status = 409;
            return {
              error: `Job is currently ${existing.status}, cannot run Intern`,
            };
          }

          if (!job.familyId || !job.conversationId) {
            set.status = 400;
            return { error: 'Job missing familyId or conversationId' };
          }

          if (!hasAIProvider) {
            await jobRepo.update(jobId, {
              status: 'awaiting_intern',
              error: 'No AI provider configured (ANTHROPIC_API_KEY missing)',
            });
            set.status = 500;
            return {
              error: 'No AI provider configured (ANTHROPIC_API_KEY missing)',
            };
          }

          const familyId = job.familyId;
          const conversationId = job.conversationId;

          // Phase 1 (triage): a real Intern LLM call per unresolved message,
          // so this runs in the background -- same fire-and-forget shape as
          // POST /api/imports's own processJob() call -- rather than
          // blocking this request. The client polls GET /api/import/:jobId
          // for progress/completion; job.status keeps its current meaning
          // (a queue-drain in progress, not a synchronous heuristic pass).
          runInternTriage({
            dbClient,
            decisionRepo,
            queueRepo,
            familyId,
            importJobId: jobId,
            conversationId,
            internProvider: aiFactory.getProviderForAgent('intern'),
            internModel: aiFactory.getModelForAgent('intern'),
            onProgress: async (processed, total) => {
              await jobRepo.update(jobId, {
                progress: {
                  current: processed,
                  total,
                  stage: `Classifying messages (${processed}/${total})...`,
                },
              });
            },
          })
            .then(async ({ total, failed, counts }) => {
              await jobRepo.update(jobId, {
                status: 'intern_complete',
                progress: {
                  current: total,
                  total,
                  stage:
                    `Intern complete: ${counts.toProcess} to process, ${counts.toSkip} to skip` +
                    (failed > 0 ? ` (${failed} failed)` : ''),
                },
              });

              await eventLogRepo.log({
                familyId,
                eventType: 'import_intern_complete',
                eventCategory: 'system_event',
                actor: 'system',
                actorType: 'system',
                severity: 'info',
                eventData: {
                  importJobId: jobId,
                  toProcess: counts.toProcess,
                  toSkip: counts.toSkip,
                  failed,
                },
              });
            })
            .catch(async (error) => {
              const message =
                error instanceof Error ? error.message : 'Unknown error';
              console.error('Intern classification failed:', error);
              await jobRepo.update(jobId, {
                status: 'awaiting_intern',
                error: message,
              });
            });

          return { success: true, status: 'running_intern' as const };
        },
        {
          params: t.Object({ jobId: t.String() }),
          detail: {
            tags: ['Import'],
            description:
              'Run Intern classification on imported messages (super admin only)',
          },
        },
      )
      /**
       * GET /api/import/:jobId/decisions
       * Get all Intern decisions with message details
       */
      .get(
        '/api/import/:jobId/decisions',
        async ({ params: { jobId }, query, set }) => {
          const job = await jobRepo.findById(jobId);
          if (!job) {
            set.status = 404;
            return { error: 'Import job not found' };
          }

          if (!job.familyId || !job.conversationId) {
            set.status = 400;
            return { error: 'Job missing familyId or conversationId' };
          }

          // Get decisions
          const decisions = await decisionRepo.findByJobId(jobId);

          // Get conversation events
          const { data: events, error: eventsError } = await dbClient
            .from('conversation_events')
            .select(
              'id, content_original, event_type, actor_display_name, occurred_at',
            )
            .eq('family_id', job.familyId)
            .eq('conversation_id', job.conversationId)
            .order('occurred_at', { ascending: true });

          if (eventsError) {
            set.status = 500;
            return { error: `Failed to get events: ${eventsError.message}` };
          }

          // Build a map of decisions by event ID
          const decisionMap = new Map(
            decisions.map((d) => [d.conversationEventId, d]),
          );

          // Combine events with decisions
          const messagesWithDecisions: MessageWithDecision[] = (
            events || []
          ).map((event) => {
            const decision = decisionMap.get(event.id);
            return {
              id: event.id,
              occurredAt: new Date(event.occurred_at),
              actorDisplayName: event.actor_display_name || 'Unknown',
              content: event.content_original || '',
              eventType: event.event_type || 'message',
              decision: decision?.decision || 'process',
              reason: decision?.reason || null,
              overridden: decision?.overridden || false,
            };
          });

          // Apply filter if provided
          const filter = (query as { filter?: string }).filter;
          let filtered = messagesWithDecisions;
          if (filter === 'process') {
            filtered = messagesWithDecisions.filter(
              (m) => m.decision === 'process',
            );
          } else if (filter === 'skip') {
            filtered = messagesWithDecisions.filter(
              (m) => m.decision === 'skip',
            );
          }

          // Get counts
          const counts = await decisionRepo.getCounts(jobId);

          return {
            messages: filtered,
            stats: counts,
            total: messagesWithDecisions.length,
          };
        },
        {
          params: t.Object({ jobId: t.String() }),
          query: t.Object({
            filter: t.Optional(
              t.Union([
                t.Literal('all'),
                t.Literal('process'),
                t.Literal('skip'),
              ]),
            ),
          }),
          detail: {
            tags: ['Import'],
            description:
              'Get Intern decisions for all messages (super admin only)',
          },
        },
      )
      /**
       * PATCH /api/import/:jobId/decisions/:eventId
       * Override an Intern decision
       */
      .patch(
        '/api/import/:jobId/decisions/:eventId',
        async ({ params: { jobId, eventId }, body, set }) => {
          const job = await jobRepo.findById(jobId);
          if (!job) {
            set.status = 404;
            return { error: 'Import job not found' };
          }

          const { decision } = body as { decision: InternDecisionType };

          try {
            const updated = await decisionRepo.override(
              jobId,
              eventId,
              decision,
            );

            // Update job progress with new counts
            const counts = await decisionRepo.getCounts(jobId);
            await jobRepo.update(jobId, {
              progress: {
                ...job.progress,
                stage: `${counts.toProcess} to process, ${counts.toSkip} to skip (${counts.overridden} overridden)`,
              },
            });

            return {
              success: true,
              decision: updated,
              stats: counts,
            };
          } catch (error) {
            set.status = 400;
            return {
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to override decision',
            };
          }
        },
        {
          params: t.Object({ jobId: t.String(), eventId: t.String() }),
          body: t.Object({
            decision: t.Union([t.Literal('process'), t.Literal('skip')]),
          }),
          detail: {
            tags: ['Import'],
            description: 'Override an Intern decision (super admin only)',
          },
        },
      )
      /**
       * POST /api/import/:jobId/submit-scribe
       * Submit selected messages to Scribe for processing
       */
      .post(
        '/api/import/:jobId/submit-scribe',
        async ({ params: { jobId }, set }) => {
          // Atomically transition to processing_scribe -- prevents two
          // concurrent submits from both proceeding (each would otherwise
          // re-enqueue and pay for the same messages twice).
          const job = await jobRepo.transitionStatus(
            jobId,
            ['intern_complete'],
            'processing_scribe',
          );

          if (!job) {
            const existing = await jobRepo.findById(jobId);
            if (!existing) {
              set.status = 404;
              return { error: 'Import job not found' };
            }
            set.status = 409;
            return {
              error: `Job is currently ${existing.status}, cannot submit to Scribe`,
            };
          }

          if (!job.familyId) {
            set.status = 400;
            await jobRepo.update(jobId, { status: 'intern_complete' });
            return { error: 'Job missing familyId' };
          }

          if (!hasAIProvider) {
            await jobRepo.update(jobId, {
              status: 'intern_complete',
              error: 'No AI provider configured (ANTHROPIC_API_KEY missing)',
            });
            set.status = 500;
            return {
              error: 'No AI provider configured (ANTHROPIC_API_KEY missing)',
            };
          }

          // Get human-reviewed decisions to process
          const decisions = await decisionRepo.findByJobId(jobId);
          const eventIds = decisions
            .filter((d) => d.decision === 'process')
            .map((d) => d.conversationEventId);

          if (eventIds.length === 0) {
            await jobRepo.update(jobId, { status: 'intern_complete' });
            set.status = 400;
            return { error: 'No messages selected for processing' };
          }

          await jobRepo.update(jobId, {
            progress: {
              current: 0,
              total: eventIds.length,
              stage: `Submitting ${eventIds.length} messages to Scribe...`,
            },
          });

          const familyId = job.familyId;
          const skipped = decisions.length - eventIds.length;

          // Phase 2 (extraction): stages: ['scribe', 'registrar'] only --
          // 'filter' is deliberately excluded (re-running it would both
          // double-pay for the same judgment and risk silently overriding a
          // human's override). Real Scribe LLM calls, so this also runs in
          // the background; the client polls GET /api/import/:jobId.
          runExtractionDrain({
            dbClient,
            queueRepo,
            familyId,
            eventIds,
            scribeProvider: aiFactory.getProviderForAgent('scribe'),
            scribeModel: aiFactory.getModelForAgent('scribe'),
            onProgress: async (processed, total) => {
              await jobRepo.update(jobId, {
                progress: {
                  current: processed,
                  total,
                  stage: `Processing with Scribe (${processed}/${total})...`,
                },
              });
            },
          })
            .then(async ({ total, processed, failed }) => {
              await jobRepo.update(jobId, {
                status: 'complete',
                progress: {
                  current: total,
                  total,
                  stage:
                    `Processed ${processed} messages` +
                    (failed > 0 ? ` (${failed} failed)` : ''),
                },
                completedAt: new Date(),
              });

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
                  messagesSkipped: skipped,
                },
              });
            })
            .catch(async (error) => {
              const message =
                error instanceof Error ? error.message : 'Unknown error';
              console.error('Scribe extraction failed:', error);
              await jobRepo.update(jobId, {
                status: 'intern_complete',
                error: message,
              });
            });

          return {
            success: true,
            status: 'processing_scribe' as const,
            submitted: eventIds.length,
          };
        },
        {
          params: t.Object({ jobId: t.String() }),
          detail: {
            tags: ['Import'],
            description:
              'Submit selected messages to Scribe (super admin only)',
          },
        },
      )
  );
}
