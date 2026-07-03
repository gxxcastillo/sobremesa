/**
 * Typed accessor for the `auth` property Elysia's context carries at
 * runtime once `createAuthPlugin`'s `.derive()` has run.
 *
 * Why this exists instead of a fully-inferred type: each API route file
 * builds its own `Elysia` instance (e.g. `identityRoutes(dbClient)`) that is
 * only later `.use()`'d alongside the auth plugin when the app is composed
 * (see `apps/api/src/app.ts`). Elysia's type inference does not carry `auth`
 * backwards into a route file that doesn't itself `.use()` the auth plugin,
 * so route handlers can't just destructure a correctly-typed `auth` off
 * `ctx`. Rather than repeat `(ctx as any).auth` at every call site, route
 * handlers take this one well-defined cast. This mirrors how `guards.ts`
 * itself reads `auth` inside `beforeHandle` (`context as unknown as {...}`)
 * — an honest acknowledgment that true end-to-end inference isn't available
 * in this plugin style, not a gap to "fix" with a bigger type hack.
 */
import type { AuthContext } from '../types';

export function getAuth(ctx: Record<string, unknown>): AuthContext {
  return ctx.auth as AuthContext;
}
