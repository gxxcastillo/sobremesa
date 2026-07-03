import { createAuthPlugin } from '@sobremesa/auth';
import type { DatabaseClient } from '@sobremesa/database';
import { createApp } from '../app';
import { TEST_JWT_SECRET } from './auth-fixtures';

/**
 * Build a `createApp()` instance wired to a fake `DatabaseClient`, using the
 * fixed test JWT secret so tokens signed via `signTestToken` verify.
 */
export function buildTestApp(dbClient: DatabaseClient) {
  // `authRoutes()` reads `process.env.ACCESS_PASS_SECRET` eagerly (it throws
  // if unset) even though none of the authz tests exercise its handlers.
  // Force it to the fixed test secret so `createApp()` doesn't depend on an
  // ambient env var that CI and fresh checkouts don't set — mirrors
  // production, where `main.ts` passes the same `ACCESS_PASS_SECRET` value
  // into both `authRoutes` and `createAuthPlugin`.
  process.env.ACCESS_PASS_SECRET = TEST_JWT_SECRET;
  const authPlugin = createAuthPlugin({ secret: TEST_JWT_SECRET, dbClient });
  return createApp({ dbClient, authPlugin });
}
