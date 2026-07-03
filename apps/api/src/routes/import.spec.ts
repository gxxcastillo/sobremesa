/**
 * Authz boundary tests for `importRoutes` (`.use(requireSuperAdmin)` on the
 * whole file — every route here is super-admin-only).
 */
import { describe, it, expect } from 'vitest';
import { buildTestApp } from '../test-support/build-test-app';
import {
  createFakeDbClient,
  buildAuthFixtures,
  signTestToken,
  authHeader,
} from '../test-support/auth-fixtures';

// Representative route: GET /api/import/:jobId. No body, so schema
// validation can't interfere with the auth assertions below.
const url = 'http://localhost/api/import/job-1';

describe('importRoutes authz (requireSuperAdmin)', () => {
  it('returns 401 with no Authorization header', async () => {
    const app = buildTestApp(createFakeDbClient());

    const res = await app.handle(new Request(url));

    expect(res.status).toBe(401);
  });

  it('returns 403 for an authenticated non-super-admin', async () => {
    const spec = {
      userId: 'user-1',
      identityId: 'identity-1',
      globalRole: 'user' as const,
      familyAccess: [],
    };
    const dbClient = createFakeDbClient(buildAuthFixtures(spec));
    const token = await signTestToken(spec);
    const app = buildTestApp(dbClient);

    const res = await app.handle(
      new Request(url, { headers: authHeader(token) }),
    );

    expect(res.status).toBe(403);
  });

  it('lets a super admin through the guard', async () => {
    const spec = {
      userId: 'user-2',
      identityId: 'identity-2',
      globalRole: 'super_admin' as const,
      familyAccess: [],
    };
    const dbClient = createFakeDbClient(buildAuthFixtures(spec));
    const token = await signTestToken(spec);
    const app = buildTestApp(dbClient);

    const res = await app.handle(
      new Request(url, { headers: authHeader(token) }),
    );

    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
