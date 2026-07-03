/**
 * Authz boundary tests for `identityRoutes` (`.use(requireFamilyMember)`).
 *
 * These test the guard, not the business logic: the DB is a minimal fake
 * (see `test-support/fake-db-client.ts`), so a request that gets past the
 * guard may still fail downstream for unrelated reasons. That's fine — this
 * file only asserts the 401/403 boundary.
 */
import { describe, it, expect } from 'vitest';
import { buildTestApp } from '../test-support/build-test-app';
import {
  createFakeDbClient,
  buildAuthFixtures,
  signTestToken,
  authHeader,
} from '../test-support/auth-fixtures';

const FAMILY_ID = 'family-1';
const OTHER_FAMILY_ID = 'family-2';

// Representative route: GET /api/family/:familyId/people. Any family
// member (viewer/member/admin) may call it; it needs no request body, so
// schema validation can't interfere with the auth assertions below.
const url = (familyId: string) =>
  `http://localhost/api/family/${familyId}/people`;

describe('identityRoutes authz (requireFamilyMember)', () => {
  it('returns 401 with no Authorization header', async () => {
    const app = buildTestApp(createFakeDbClient());

    const res = await app.handle(new Request(url(FAMILY_ID)));

    expect(res.status).toBe(401);
  });

  it('returns 403 for an identity with no family_access row for the family', async () => {
    const spec = {
      userId: 'user-1',
      identityId: 'identity-1',
      familyAccess: [{ familyId: OTHER_FAMILY_ID, role: 'admin' as const }],
    };
    const dbClient = createFakeDbClient(buildAuthFixtures(spec));
    const token = await signTestToken(spec);
    const app = buildTestApp(dbClient);

    const res = await app.handle(
      new Request(url(FAMILY_ID), { headers: authHeader(token) }),
    );

    expect(res.status).toBe(403);
  });

  it('lets a viewer (lowest role) through the guard', async () => {
    const spec = {
      userId: 'user-2',
      identityId: 'identity-2',
      familyAccess: [{ familyId: FAMILY_ID, role: 'viewer' as const }],
    };
    const dbClient = createFakeDbClient(buildAuthFixtures(spec));
    const token = await signTestToken(spec);
    const app = buildTestApp(dbClient);

    const res = await app.handle(
      new Request(url(FAMILY_ID), { headers: authHeader(token) }),
    );

    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it('lets a super admin through regardless of family_access', async () => {
    const spec = {
      userId: 'user-3',
      identityId: 'identity-3',
      globalRole: 'super_admin' as const,
      familyAccess: [],
    };
    const dbClient = createFakeDbClient(buildAuthFixtures(spec));
    const token = await signTestToken(spec);
    const app = buildTestApp(dbClient);

    const res = await app.handle(
      new Request(url(FAMILY_ID), { headers: authHeader(token) }),
    );

    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
