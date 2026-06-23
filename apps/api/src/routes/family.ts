import { Elysia, t } from 'elysia';
import type { DatabaseClient } from '@sobremesa/database';
import { ProcessingQueueRepository } from '@sobremesa/database';
import { hasAccessToFamily, type AuthContext } from '@sobremesa/auth';
import { QueuePriority } from '@sobremesa/shared-types';

function getAuth(ctx: Record<string, unknown>): AuthContext {
  return ctx.auth as AuthContext;
}

/**
 * Family-related API routes
 */
export function familyRoutes(dbClient: DatabaseClient) {
  const queueRepo = new ProcessingQueueRepository(dbClient);

  return (
    new Elysia()
      /**
       * POST /api/family/:familyId/reprocess
       * Enqueue all unprocessed messages for Scribe processing
       * Requires authentication and admin access to the family
       */
      .post(
        '/api/family/:familyId/reprocess',
        async (ctx) => {
          const {
            params: { familyId },
            body,
            set,
          } = ctx;
          const auth = getAuth(ctx);
          if (!auth.isAuthenticated || !auth.identity) {
            set.status = 401;
            return { error: 'Authentication required' };
          }

          // Check access - require admin role for this family
          if (!hasAccessToFamily(auth, familyId)) {
            set.status = 403;
            return { error: 'Access denied to this family' };
          }

          // Check if user has admin access to this family
          const familyAccess = auth.familyAccess?.find(
            (fa) => fa.familyId === familyId,
          );
          if (!familyAccess || familyAccess.role !== 'admin') {
            // Allow super admins to bypass
            if (!auth.isSuperAdmin) {
              set.status = 403;
              return { error: 'Admin access required to reprocess messages' };
            }
          }

          const { includeAlreadyProcessed = false, skipInQueue = true } =
            body || {};

          try {
            // Get all conversation events for this family
            const { data: events, error: eventsError } = await dbClient
              .from('conversation_events')
              .select('id')
              .eq('family_id', familyId)
              .order('occurred_at', { ascending: true });

            if (eventsError) {
              console.error('[Reprocess] Failed to fetch events:', eventsError);
              set.status = 500;
              return { error: 'Failed to fetch conversation events' };
            }

            if (!events || events.length === 0) {
              return {
                success: true,
                message: 'No messages found for this family',
                enqueued: 0,
                skipped: 0,
              };
            }

            const eventIds = events.map((e) => e.id);
            let toEnqueue = eventIds;

            // Optionally skip events already in queue (any status)
            if (skipInQueue) {
              const { data: queuedItems } = await dbClient
                .from('processing_queue')
                .select('conversation_event_id')
                .eq('family_id', familyId)
                .in('conversation_event_id', eventIds);

              const queuedIds = new Set(
                queuedItems?.map((q) => q.conversation_event_id) || [],
              );
              toEnqueue = toEnqueue.filter((id) => !queuedIds.has(id));
            }

            // Optionally skip events already processed (have processing record)
            if (!includeAlreadyProcessed) {
              const { data: processedItems } = await dbClient
                .from('conversation_event_processing')
                .select('conversation_event_id')
                .eq('family_id', familyId)
                .in('conversation_event_id', toEnqueue);

              const processedIds = new Set(
                processedItems?.map((p) => p.conversation_event_id) || [],
              );
              toEnqueue = toEnqueue.filter((id) => !processedIds.has(id));
            }

            // Enqueue all messages
            let enqueued = 0;
            let errors = 0;

            for (const eventId of toEnqueue) {
              try {
                await queueRepo.enqueue(familyId, eventId, {
                  priority: QueuePriority.NORMAL,
                });
                enqueued++;
              } catch (err) {
                // Ignore duplicate errors (already queued)
                const errorMessage =
                  err instanceof Error ? err.message : String(err);
                if (!errorMessage.includes('23505')) {
                  console.error(
                    `[Reprocess] Failed to enqueue ${eventId}:`,
                    err,
                  );
                  errors++;
                }
              }
            }

            const skipped = eventIds.length - toEnqueue.length;

            console.log(
              `[Reprocess] Family ${familyId}: enqueued ${enqueued}, skipped ${skipped}, errors ${errors}`,
            );

            return {
              success: true,
              message: `Enqueued ${enqueued} messages for processing`,
              enqueued,
              skipped,
              errors,
              total: eventIds.length,
            };
          } catch (err) {
            console.error('[Reprocess] Unexpected error:', err);
            set.status = 500;
            return { error: 'Failed to reprocess messages' };
          }
        },
        {
          params: t.Object({ familyId: t.String() }),
          body: t.Optional(
            t.Object({
              includeAlreadyProcessed: t.Optional(t.Boolean()),
              skipInQueue: t.Optional(t.Boolean()),
            }),
          ),
          detail: {
            tags: ['Family'],
            description:
              'Enqueue all unprocessed messages for Scribe processing (admin only)',
          },
        },
      )
      /**
       * GET /api/family/:familyId/queue-stats
       * Get processing queue statistics for a family
       * Requires authentication and access to the family
       */
      .get(
        '/api/family/:familyId/queue-stats',
        async (ctx) => {
          const {
            params: { familyId },
            set,
          } = ctx;
          const auth = getAuth(ctx);
          if (!auth.isAuthenticated || !auth.identity) {
            set.status = 401;
            return { error: 'Authentication required' };
          }

          if (!hasAccessToFamily(auth, familyId)) {
            set.status = 403;
            return { error: 'Access denied to this family' };
          }

          try {
            const stats = await queueRepo.getStats(familyId);

            // Also get total conversation events count
            const { count: totalEvents } = await dbClient
              .from('conversation_events')
              .select('*', { count: 'exact', head: true })
              .eq('family_id', familyId);

            // Get count of processed events
            const { count: processedEvents } = await dbClient
              .from('conversation_event_processing')
              .select('*', { count: 'exact', head: true })
              .eq('family_id', familyId);

            return {
              queue: stats,
              totalEvents: totalEvents || 0,
              processedEvents: processedEvents || 0,
              unprocessedEvents: (totalEvents || 0) - (processedEvents || 0),
            };
          } catch (err) {
            console.error('[QueueStats] Error:', err);
            set.status = 500;
            return { error: 'Failed to fetch queue stats' };
          }
        },
        {
          params: t.Object({ familyId: t.String() }),
          detail: {
            tags: ['Family'],
            description: 'Get processing queue statistics for a family',
          },
        },
      )
  );
}
