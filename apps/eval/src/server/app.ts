import { Elysia } from 'elysia';
import type { DatabaseClient } from '@sobremesa/database';
import { scenarioRoutes } from './routes/scenarios';
import { familyRoutes } from './routes/families';
import { familyGoldenRoutes } from './routes/family-goldens';
import { runRoutes } from './routes/runs';
import { traceRoutes } from './routes/trace';
import { previewRoutes } from './routes/preview';
import { providerRoutes } from './routes/providers';
import { importVerificationRoutes } from './routes/import-verification';
import type { EvalStore } from './store';

export interface CreateAppConfig {
  dbClient: DatabaseClient;
  store: EvalStore;
}

/**
 * Local-only dev tool: single user, no auth, no CORS lockdown, no swagger —
 * see eval-site-plan.md decision #5.
 */
export function createApp({ dbClient, store }: CreateAppConfig) {
  return (
    new Elysia()
      .use(scenarioRoutes())
      .use(familyRoutes(dbClient))
      .use(familyGoldenRoutes(dbClient, store))
      .use(traceRoutes(dbClient))
      .use(previewRoutes(dbClient))
      .use(runRoutes(dbClient, store))
      .use(providerRoutes())
      .use(importVerificationRoutes(dbClient))
      .get('/health', () => ({
        status: 'ok',
        timestamp: new Date().toISOString(),
      }))
      // Same handler under /api/ so the frontend's connectivity check can hit
      // it through the Vite dev proxy (which only forwards /api/*) — see
      // `apps/eval/src/app/connection.ts`.
      .get('/api/health', () => ({
        status: 'ok',
        timestamp: new Date().toISOString(),
      }))
      .onError(({ code, error, set }) => {
        if (code === 'NOT_FOUND' || code === 'VALIDATION' || code === 'PARSE') {
          return;
        }
        console.error('Unhandled error:', error);
        set.status = 500;
        return { error: 'Internal server error' };
      })
  );
}
