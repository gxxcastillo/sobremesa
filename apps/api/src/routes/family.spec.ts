/**
 * Authz boundary tests for `familyRoutes`, which is split into three
 * guard-scoped groups (see the file's own doc comment):
 * - member routes (`requireFamilyMember`) — e.g. queue-stats
 * - admin routes (`requireFamilyAdmin`) — e.g. queue/errors
 * - the parameterless `/api/family/summary` route (`requireAuth` only, plus
 *   an inline `hasAccessToFamily` check after the family lookup)
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

describe('familyRoutes member group authz (requireFamilyMember)', () => {
  const url = `http://localhost/api/family/${FAMILY_ID}/queue-stats`;

  it('returns 401 with no Authorization header', async () => {
    const app = buildTestApp(createFakeDbClient());

    const res = await app.handle(new Request(url));

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
      new Request(url, { headers: authHeader(token) }),
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
      new Request(url, { headers: authHeader(token) }),
    );

    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

describe('familyRoutes admin group authz (requireFamilyAdmin)', () => {
  const url = `http://localhost/api/family/${FAMILY_ID}/queue/errors`;

  it('returns 401 with no Authorization header', async () => {
    const app = buildTestApp(createFakeDbClient());

    const res = await app.handle(new Request(url));

    expect(res.status).toBe(401);
  });

  it('returns 403 for a member role (below the admin minimum)', async () => {
    const spec = {
      userId: 'user-3',
      identityId: 'identity-3',
      familyAccess: [{ familyId: FAMILY_ID, role: 'member' as const }],
    };
    const dbClient = createFakeDbClient(buildAuthFixtures(spec));
    const token = await signTestToken(spec);
    const app = buildTestApp(dbClient);

    const res = await app.handle(
      new Request(url, { headers: authHeader(token) }),
    );

    expect(res.status).toBe(403);
  });

  it('lets an admin role through the guard', async () => {
    const spec = {
      userId: 'user-4',
      identityId: 'identity-4',
      familyAccess: [{ familyId: FAMILY_ID, role: 'admin' as const }],
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

  it('lets a super admin through with no family_access at all', async () => {
    const spec = {
      userId: 'user-5',
      identityId: 'identity-5',
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

describe('familyRoutes active-family summary route (requireAuth + inline hasAccessToFamily)', () => {
  const url = 'http://localhost/api/family/summary';

  // This route looks up "the first active family with a chat ID" before it
  // knows which family is being accessed, so it can't use a param-based
  // guard. Seed a `families` row so the lookup succeeds and the inline
  // `hasAccessToFamily` check is actually exercised.
  const familiesTable = [
    {
      id: FAMILY_ID,
      name: 'Test Family',
      chat_id: 'chat-1',
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];

  it('returns 401 with no Authorization header', async () => {
    const app = buildTestApp(createFakeDbClient({ families: familiesTable }));

    const res = await app.handle(new Request(url));

    expect(res.status).toBe(401);
  });

  it('returns 403 for an authenticated identity with no access to the active family', async () => {
    const spec = {
      userId: 'user-6',
      identityId: 'identity-6',
      familyAccess: [],
    };
    const dbClient = createFakeDbClient(
      buildAuthFixtures(spec, { families: familiesTable }),
    );
    const token = await signTestToken(spec);
    const app = buildTestApp(dbClient);

    const res = await app.handle(
      new Request(url, { headers: authHeader(token) }),
    );

    expect(res.status).toBe(403);
  });

  it('succeeds for an identity with access to the active family', async () => {
    const spec = {
      userId: 'user-7',
      identityId: 'identity-7',
      familyAccess: [{ familyId: FAMILY_ID, role: 'viewer' as const }],
    };
    const dbClient = createFakeDbClient(
      buildAuthFixtures(spec, { families: familiesTable }),
    );
    const token = await signTestToken(spec);
    const app = buildTestApp(dbClient);

    const res = await app.handle(
      new Request(url, { headers: authHeader(token) }),
    );

    expect(res.status).toBe(200);
  });
});
