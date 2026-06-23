/**
 * Import Routes
 *
 * Handles WhatsApp and other chat history import endpoints:
 * - POST /api/imports - Start import job (collection)
 * - POST /api/imports/check-duplicates - Check for duplicates (collection)
 * - GET /api/import/:jobId - Get job status (single resource)
 * - POST /api/import/:jobId/cancel - Cancel import
 * - POST /api/import/:jobId/resume - Resume failed import
 *
 * All routes require super_admin access.
 */

import { Elysia, t } from 'elysia';
import type { DatabaseClient } from '@sobremesa/database';
import {
  EventLogRepository,
  ProcessingQueueRepository,
} from '@sobremesa/database';
import {
  ImportJobRepository,
  ImportProcessor,
  InternDecisionRepository,
} from '@sobremesa/import';
import { QueuePriority } from '@sobremesa/shared-types';
import type {
  ImportConfig,
  ImportStatus,
  MessageWithDecision,
  InternDecisionType,
  MessageFingerprint,
  DuplicateCheckResult,
} from '@sobremesa/shared-types';

/**
 * Auth context shape provided by the auth plugin.
 * Typed here to avoid `(ctx as any).auth` throughout the route handlers.
 */
interface AuthContext {
  isAuthenticated: boolean;
  isSuperAdmin: boolean;
  identity: { id: string; displayName?: string } | null;
}

function getAuth(ctx: Record<string, unknown>): AuthContext {
  return ctx.auth as AuthContext;
}

/**
 * Import routes factory
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

  return (
    new Elysia()
      /**
       * POST /api/imports/check-duplicates
       * Check how many messages already exist in the database
       */
      .post(
        '/api/imports/check-duplicates',
        async (ctx) => {
          const { body, set } = ctx;
          const auth = getAuth(ctx);

          if (!auth.isAuthenticated || !auth.isSuperAdmin) {
            set.status = 403;
            return { error: 'Super admin access required' };
          }

          const { source, messages } = body as {
            source: 'whatsapp' | 'telegram' | 'other';
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
          // Require super admin
          if (!auth.isAuthenticated || !auth.isSuperAdmin || !auth.identity) {
            set.status = 403;
            return { error: 'Super admin access required' };
          }

          const file = body.file;
          const source = body.source;

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
            source: t.Literal('whatsapp'),
          }),
          detail: {
            tags: ['Import'],
            description: 'Start a WhatsApp import job (super admin only)',
          },
        },
      )
      /**
       * GET /api/import/:jobId
       * Get import job status
       */
      .get(
        '/api/import/:jobId',
        async (ctx) => {
          const {
            params: { jobId },
            set,
          } = ctx;
          const auth = getAuth(ctx);

          // Require super admin
          if (!auth.isAuthenticated || !auth.isSuperAdmin) {
            set.status = 403;
            return { error: 'Super admin access required' };
          }

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

          // Require super admin
          if (!auth.isAuthenticated || !auth.isSuperAdmin) {
            set.status = 403;
            return { error: 'Super admin access required' };
          }

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
        async (ctx) => {
          const {
            params: { jobId },
            set,
          } = ctx;
          const auth = getAuth(ctx);

          // Require super admin
          if (!auth.isAuthenticated || !auth.isSuperAdmin) {
            set.status = 403;
            return { error: 'Super admin access required' };
          }

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
        async (ctx) => {
          const {
            params: { jobId },
            set,
          } = ctx;
          const auth = getAuth(ctx);

          if (!auth.isAuthenticated || !auth.isSuperAdmin) {
            set.status = 403;
            return { error: 'Super admin access required' };
          }

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

          try {
            // Get all conversation events for this job
            const { data: events, error: eventsError } = await dbClient
              .from('conversation_events')
              .select(
                'id, content_original, event_type, actor_display_name, occurred_at',
              )
              .eq('family_id', job.familyId)
              .eq('conversation_id', job.conversationId)
              .order('occurred_at', { ascending: true });

            if (eventsError) {
              throw new Error(`Failed to get events: ${eventsError.message}`);
            }

            // Clear existing decisions
            await decisionRepo.deleteByJobId(jobId);

            // For now, use simple heuristics instead of actual Intern agent
            // TODO: Replace with actual Intern agent call
            const decisions: Array<{
              familyId: string;
              importJobId: string;
              conversationEventId: string;
              decision: InternDecisionType;
              reason: string | null;
            }> = [];

            for (const event of events || []) {
              const content = event.content_original?.trim() || '';
              const eventType = event.event_type;

              let decision: InternDecisionType = 'process';
              let reason: string | null = null;

              // Simple heuristics for classification - conservative approach
              // Only skip messages with truly no semantic content
              if (eventType !== 'message') {
                // Skip media-only messages
                decision = 'skip';
                reason = 'media-only';
              } else if (content.length === 0) {
                decision = 'skip';
                reason = 'empty-message';
              } else if (/^[\p{Emoji}\s]+$/u.test(content)) {
                // Emoji-only messages
                decision = 'skip';
                reason = 'emoji-only';
              } else if (
                /^(ok|okay|yes|no|yeah|yep|nope|sure|thanks|ty|thx|gracias|lol|haha|hehe|jaja|jajaja|wow|omg|nice|cool|great|awesome|bueno|dale|va|sí|si)[!?.]*$/i.test(
                  content.trim(),
                )
              ) {
                // Pure acknowledgements with no additional content
                decision = 'skip';
                reason = 'acknowledgement';
              }

              decisions.push({
                familyId: job.familyId,
                importJobId: jobId,
                conversationEventId: event.id,
                decision,
                reason,
              });
            }

            // Bulk insert decisions
            await decisionRepo.bulkInsert(decisions);

            // Get counts
            const counts = await decisionRepo.getCounts(jobId);

            // Update job status
            await jobRepo.update(jobId, {
              status: 'intern_complete',
              progress: {
                ...job.progress,
                stage: `Intern complete: ${counts.toProcess} to process, ${counts.toSkip} to skip`,
              },
            });

            // Log event
            if (job.familyId) {
              await eventLogRepo.log({
                familyId: job.familyId,
                eventType: 'import_intern_complete',
                eventCategory: 'system_event',
                actor: 'system',
                actorType: 'system',
                severity: 'info',
                eventData: {
                  importJobId: jobId,
                  toProcess: counts.toProcess,
                  toSkip: counts.toSkip,
                },
              });
            }

            return {
              success: true,
              stats: counts,
            };
          } catch (error) {
            const message =
              error instanceof Error ? error.message : 'Unknown error';
            // Revert to awaiting_intern on error
            await jobRepo.update(jobId, {
              status: 'awaiting_intern',
              error: message,
            });
            console.error('Intern classification failed:', error);
            set.status = 500;
            return { error: `Intern classification failed: ${message}` };
          }
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
        async (ctx) => {
          const {
            params: { jobId },
            query,
            set,
          } = ctx;
          const auth = getAuth(ctx);

          if (!auth.isAuthenticated || !auth.isSuperAdmin) {
            set.status = 403;
            return { error: 'Super admin access required' };
          }

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
        async (ctx) => {
          const {
            params: { jobId, eventId },
            body,
            set,
          } = ctx;
          const auth = getAuth(ctx);

          if (!auth.isAuthenticated || !auth.isSuperAdmin) {
            set.status = 403;
            return { error: 'Super admin access required' };
          }

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
        async (ctx) => {
          const {
            params: { jobId },
            set,
          } = ctx;
          const auth = getAuth(ctx);

          if (!auth.isAuthenticated || !auth.isSuperAdmin) {
            set.status = 403;
            return { error: 'Super admin access required' };
          }

          const job = await jobRepo.findById(jobId);
          if (!job) {
            set.status = 404;
            return { error: 'Import job not found' };
          }

          if (job.status !== 'intern_complete') {
            set.status = 400;
            return { error: 'Job must be in intern_complete status' };
          }

          if (!job.familyId) {
            set.status = 400;
            return { error: 'Job missing familyId' };
          }

          // Get decisions to process
          const decisions = await decisionRepo.findByJobId(jobId);
          const toProcess = decisions.filter((d) => d.decision === 'process');

          if (toProcess.length === 0) {
            set.status = 400;
            return { error: 'No messages selected for processing' };
          }

          // Update status
          await jobRepo.update(jobId, {
            status: 'processing_scribe',
            progress: {
              current: 0,
              total: toProcess.length,
              stage: `Submitting ${toProcess.length} messages to Scribe...`,
            },
          });

          let queued = 0;
          for (const decision of toProcess) {
            await queueRepo.enqueue(
              job.familyId,
              decision.conversationEventId,
              {
                priority: QueuePriority.NORMAL,
              },
            );
            queued++;
          }

          await jobRepo.update(jobId, {
            status: 'complete',
            progress: {
              current: queued,
              total: toProcess.length,
              stage: `Queued ${queued} messages for Scribe processing`,
            },
            completedAt: new Date(),
          });

          // Log completion
          if (job.familyId) {
            await eventLogRepo.log({
              familyId: job.familyId,
              eventType: 'import_completed',
              eventCategory: 'system_event',
              actor: 'system',
              actorType: 'system',
              severity: 'info',
              eventData: {
                importJobId: jobId,
                source: job.source,
                messagesQueued: queued,
                messagesSkipped: decisions.length - toProcess.length,
              },
            });
          }

          return {
            success: true,
            processed: queued,
            skipped: decisions.length - toProcess.length,
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
