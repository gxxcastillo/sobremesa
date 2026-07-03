/**
 * Elysia app factory.
 *
 * Pulled out of `main.ts` so it can be constructed and exercised in tests
 * via `app.handle(new Request(...))` without opening a network port or
 * requiring real environment variables — `main.ts` is the only place that
 * reads `process.env` for bootstrapping and calls `.listen()`.
 */
import { Elysia } from 'elysia';
import { swagger } from '@elysiajs/swagger';
import { cors } from '@elysiajs/cors';
import type { DatabaseClient } from '@sobremesa/database';
import type { createAuthPlugin } from '@sobremesa/auth';
import { authRoutes } from './routes/auth';
import { identityRoutes } from './routes/identity';
import { importRoutes } from './routes/import';
import { familyRoutes } from './routes/family';
import { adminRoutes } from './routes/admin';

export interface CreateAppConfig {
  dbClient: DatabaseClient;
  authPlugin: ReturnType<typeof createAuthPlugin>;
}

export function createApp({ dbClient, authPlugin }: CreateAppConfig) {
  return (
    new Elysia()
      .use(swagger())
      .use(
        cors({
          origin: process.env.STUDIO_URL || 'https://localhost:3000',
          credentials: true,
        }),
      )
      .use(authPlugin)
      .use(authRoutes(dbClient))
      .use(identityRoutes(dbClient))
      .use(importRoutes(dbClient))
      .use(familyRoutes(dbClient))
      .use(adminRoutes(dbClient))
      .get(
        '/health',
        () => ({
          status: 'ok',
          timestamp: new Date().toISOString(),
        }),
        {
          detail: {
            tags: ['Health'],
            description: 'Health check endpoint',
          },
        },
      )
      /**
       * GET /api/public/stats
       * Public aggregate stats (no auth required)
       */
      .get(
        '/api/public/stats',
        async ({ set }) => {
          try {
            // Get aggregate stats across all families
            const [familiesCount, peopleCount, storiesCount, eventsCount] =
              await Promise.all([
                dbClient
                  .from('families')
                  .select('*', { count: 'exact', head: true })
                  .eq('is_active', true),
                dbClient
                  .from('people')
                  .select('*', { count: 'exact', head: true })
                  .eq('redacted', false),
                dbClient
                  .from('stories')
                  .select('*', { count: 'exact', head: true })
                  .eq('redacted', false),
                dbClient
                  .from('events')
                  .select('*', { count: 'exact', head: true })
                  .eq('redacted', false),
              ]);

            // Log any database errors
            if (familiesCount.error)
              console.error(
                '[public/stats] families error:',
                familiesCount.error,
              );
            if (peopleCount.error)
              console.error('[public/stats] people error:', peopleCount.error);
            if (storiesCount.error)
              console.error(
                '[public/stats] stories error:',
                storiesCount.error,
              );
            if (eventsCount.error)
              console.error('[public/stats] events error:', eventsCount.error);

            return {
              totalFamilies: familiesCount.count || 0,
              totalPeople: peopleCount.count || 0,
              totalStories: storiesCount.count || 0,
              totalEvents: eventsCount.count || 0,
            };
          } catch (err) {
            console.error('[public/stats] Unexpected error:', err);
            set.status = 500;
            return { error: 'Failed to fetch public stats' };
          }
        },
        {
          detail: {
            tags: ['Public'],
            description: 'Get public aggregate statistics',
          },
        },
      )
      // Error handling
      .onError(({ code, error, set }) => {
        // Let Elysia handle expected errors (404, validation, etc.)
        if (code === 'NOT_FOUND' || code === 'VALIDATION' || code === 'PARSE') {
          return;
        }

        // Log unexpected errors
        console.error('Unhandled error:', error);
        set.status = 500;
        return { error: 'Internal server error' };
      })
  );
}
