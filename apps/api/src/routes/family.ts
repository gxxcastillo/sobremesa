import { Elysia, t } from 'elysia';
import type { DatabaseClient } from '@sobremesa/database';
import {
  ProcessingQueueRepository,
  FamilyRepository,
} from '@sobremesa/database';
import {
  hasAccessToFamily,
  requireAuth,
  requireFamilyMember,
  requireFamilyAdmin,
  getAuth,
} from '@sobremesa/auth';
import { QueuePriority } from '@sobremesa/shared-types';

/**
 * Fetch the people/relationships/places/events/stories/question-stats content
 * shared by both summary routes below (`:familyId/summary` and the
 * parameterless "active family" summary) — everything except the family's
 * own id/name, which each caller already has in a different shape.
 */
async function fetchFamilySummaryContent(
  dbClient: DatabaseClient,
  familyId: string,
) {
  const [
    peopleRes,
    relationshipsRes,
    placesRes,
    eventsRes,
    storiesRes,
    questionsRes,
  ] = await Promise.all([
    dbClient
      .from('people')
      .select('name, aliases, birth_year, death_year, notes_original')
      .eq('family_id', familyId)
      .eq('redacted', false)
      .or('is_placeholder.is.null,is_placeholder.eq.false')
      .order('created_at', { ascending: true }),

    dbClient
      .from('relationships')
      .select(
        `
          relationship_type,
          person_a:person_a_id(name),
          person_b:person_b_id(name)
        `,
      )
      .eq('family_id', familyId),

    dbClient
      .from('places')
      .select('name, type, city, region, country, context_original')
      .eq('family_id', familyId)
      .eq('redacted', false)
      .order('created_at', { ascending: true }),

    dbClient
      .from('events')
      .select('title, event_type, date_text, date_year, description_original')
      .eq('family_id', familyId)
      .eq('redacted', false)
      .order('date_year', { ascending: true, nullsFirst: false }),

    dbClient
      .from('stories')
      .select('title, content_original, themes, completeness')
      .eq('family_id', familyId)
      .eq('redacted', false)
      .order('created_at', { ascending: false }),

    dbClient.from('questions').select('status').eq('family_id', familyId),
  ]);

  const questionStats = questionsRes.data || [];

  return {
    people: peopleRes.data || [],
    relationships: relationshipsRes.data || [],
    places: placesRes.data || [],
    events: eventsRes.data || [],
    stories: storiesRes.data || [],
    questions: {
      proposed: questionStats.filter((q) => q.status === 'proposed').length,
      asked: questionStats.filter((q) => q.status === 'asked').length,
      answered: questionStats.filter((q) => q.status === 'answered').length,
    },
  };
}

/**
 * Family-related API routes.
 *
 * Split into guard-scoped groups rather than one flat Elysia instance,
 * because the routes here don't all require the same authorization level:
 * - `memberRoutes`: any family member (viewer/member/admin) may call these.
 * - `adminRoutes`: family admin (or super admin) only.
 * - `activeFamilySummaryRoute`: the one route that can't use a param-based
 *   guard (see below).
 */
export function familyRoutes(dbClient: DatabaseClient) {
  const queueRepo = new ProcessingQueueRepository(dbClient);

  const memberRoutes = new Elysia()
    .use(requireFamilyMember)
    /**
     * GET /api/family/:familyId/queue-stats
     * Get processing queue statistics for a family
     */
    .get(
      '/api/family/:familyId/queue-stats',
      async ({ params: { familyId }, set }) => {
        try {
          const [stats, totalEventsRes, processedEventsRes] = await Promise.all(
            [
              queueRepo.getStats(familyId),
              dbClient
                .from('conversation_events')
                .select('*', { count: 'exact', head: true })
                .eq('family_id', familyId),
              dbClient
                .from('conversation_event_processing')
                .select('*', { count: 'exact', head: true })
                .eq('family_id', familyId),
            ],
          );
          const totalEvents = totalEventsRes.count;
          const processedEvents = processedEventsRes.count;

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
    /**
     * GET /api/family/:familyId/summary
     * Get the summary for a specific family
     */
    .get(
      '/api/family/:familyId/summary',
      async ({ params: { familyId }, set }) => {
        const [content, familyRes] = await Promise.all([
          fetchFamilySummaryContent(dbClient, familyId),
          dbClient.from('families').select('name').eq('id', familyId).single(),
        ]);

        if (!familyRes.data) {
          set.status = 404;
          return { error: 'Family not found' };
        }

        return {
          familyId,
          familyName: familyRes.data.name,
          ...content,
        };
      },
      {
        params: t.Object({ familyId: t.String() }),
        detail: {
          tags: ['Family'],
          description: 'Get the summary for a specific family',
        },
      },
    )
    /**
     * POST /api/family/:familyId/narrative
     * Generate a narrative for a family
     */
    .post(
      '/api/family/:familyId/narrative',
      async ({ params: { familyId }, body }) => {
        const { audience = 'general' } = body || {};

        // TODO: Implement narrative generation logic
        // For now, return a stub response
        return {
          narrative: `This is a generated narrative for family ${familyId} with audience: ${audience}. Implementation coming soon.`,
          audience,
          familyId,
        };
      },
      {
        params: t.Object({ familyId: t.String() }),
        body: t.Optional(
          t.Object({
            audience: t.Optional(t.String({ default: 'general' })),
          }),
        ),
        detail: {
          tags: ['Family'],
          description: 'Generate a narrative for a family',
        },
      },
    )
    /**
     * POST /api/family/:familyId/book
     * Generate a book for a family
     */
    .post(
      '/api/family/:familyId/book',
      async ({ params: { familyId }, body }) => {
        const { audience = 'general' } = body || {};

        // TODO: Implement book generation logic
        // For now, return a stub response
        return {
          message: `Book generation started for family ${familyId} with audience: ${audience}`,
          audience,
          familyId,
          status: 'queued',
        };
      },
      {
        params: t.Object({ familyId: t.String() }),
        body: t.Optional(
          t.Object({
            audience: t.Optional(t.String({ default: 'general' })),
          }),
        ),
        detail: {
          tags: ['Family'],
          description: 'Generate a book for a family',
        },
      },
    );

  const adminRoutes = new Elysia()
    .use(requireFamilyAdmin)
    /**
     * POST /api/family/:familyId/reprocess
     * Enqueue all unprocessed messages for Scribe processing
     */
    .post(
      '/api/family/:familyId/reprocess',
      async ({ params: { familyId }, body, set }) => {
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
                console.error(`[Reprocess] Failed to enqueue ${eventId}:`, err);
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
     * GET /api/family/:familyId/queue/errors
     * List dead-lettered queue items (status='error') for a family.
     */
    .get(
      '/api/family/:familyId/queue/errors',
      async ({ params: { familyId }, query, set }) => {
        try {
          // Clamp both bounds: Postgres/PostgREST reject a negative
          // OFFSET/LIMIT outright (a 500, not a clean 400), and the high-end
          // cap on `limit` keeps a single request from paging the whole table.
          const limit = Math.min(Math.max(0, query.limit ?? 100), 500);
          const offset = Math.max(0, query.offset ?? 0);

          // `getErrors` is paginated (`limit`/`offset`) — `count` must come
          // from a true `count: 'exact'` query, not `items.length`, or it
          // silently plateaus at the page size once a family has more
          // dead-lettered items than fit in one page. `getErrorCount` is a
          // single-status count, cheaper than `getStats`'s four.
          const [items, count] = await Promise.all([
            queueRepo.getErrors(familyId, { limit, offset }),
            queueRepo.getErrorCount(familyId),
          ]);
          return {
            count,
            items: items.map((item) => ({
              id: item.id,
              conversationEventId: item.conversationEventId,
              attempts: item.attempts,
              lastError: item.lastError,
              queuedAt: item.queuedAt,
            })),
          };
        } catch (err) {
          console.error('[QueueErrors] Error:', err);
          set.status = 500;
          return { error: 'Failed to fetch dead-letter items' };
        }
      },
      {
        params: t.Object({ familyId: t.String() }),
        query: t.Object({
          limit: t.Optional(t.Numeric()),
          offset: t.Optional(t.Numeric()),
        }),
        detail: {
          tags: ['Family'],
          description:
            'List dead-lettered queue items (admin only), paginated via ?limit&offset (limit capped at 500, default 100)',
        },
      },
    )
    /**
     * POST /api/family/:familyId/queue/:itemId/requeue
     * Reset a dead-lettered item back to 'queued' for retry.
     */
    .post(
      '/api/family/:familyId/queue/:itemId/requeue',
      async ({ params: { familyId, itemId }, set }) => {
        try {
          const requeued = await queueRepo.requeue(familyId, itemId);
          if (!requeued) {
            set.status = 404;
            return {
              error: 'Queue item not found or not eligible for requeue',
            };
          }
          return { success: true };
        } catch (err) {
          console.error('[QueueRequeue] Error:', err);
          set.status = 500;
          return { error: 'Failed to requeue item' };
        }
      },
      {
        params: t.Object({ familyId: t.String(), itemId: t.String() }),
        detail: {
          tags: ['Family'],
          description:
            'Reset a dead-lettered queue item back to queued (admin only)',
        },
      },
    );

  // GET /api/family/summary
  //
  // Exception to the param-based-guard pattern above: this route finds "the
  // first active family with a chat ID" dynamically, so the family being
  // accessed isn't known until after the lookup runs inside the handler.
  // `requireFamilyMember`/`requireFamilyAdmin` key off a `:familyId` route
  // param that doesn't exist here, so they can't gate this route. It gets
  // `requireAuth` for the 401 leg; the 403 `hasAccessToFamily` check has to
  // stay inline in the handler, after the family lookup.
  const activeFamilySummaryRoute = new Elysia().use(requireAuth).get(
    '/api/family/summary',
    async (ctx) => {
      const { set } = ctx;
      const auth = getAuth(ctx);
      const familyRepo = new FamilyRepository(dbClient);

      // Get family
      const families = await familyRepo.findAllActive();
      const family = families.find((f) => f.chatId);

      if (!family) {
        set.status = 404;
        return { error: 'No family with chat ID found' };
      }

      // Check access
      if (!hasAccessToFamily(auth, family.id)) {
        set.status = 403;
        return { error: 'Access denied to this family' };
      }

      const content = await fetchFamilySummaryContent(dbClient, family.id);

      return {
        familyId: family.id,
        familyName: family.name,
        ...content,
      };
    },
    {
      detail: {
        tags: ['Family'],
        description:
          'Get the summary for the active family (first family with chatId)',
      },
    },
  );

  return new Elysia()
    .use(memberRoutes)
    .use(adminRoutes)
    .use(activeFamilySummaryRoute);
}
