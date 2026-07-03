/**
 * Test helpers for building an authenticated request against a `createApp()`
 * instance backed by the fake DB client, without a live Supabase instance.
 */
import {
  createSessionToken,
  type FamilyRole,
  type GlobalRole,
} from '@sobremesa/auth';
import { createFakeDbClient, type FakeFixtures } from './fake-db-client';

export const TEST_JWT_SECRET = 'item-d-authz-test-secret';

export interface TestFamilyAccess {
  familyId: string;
  role: FamilyRole;
  status?: 'active' | 'pending' | 'revoked' | 'suspended';
}

export interface TestIdentitySpec {
  userId: string;
  identityId: string;
  globalRole?: GlobalRole;
  familyAccess?: TestFamilyAccess[];
}

/**
 * Build fixture rows (users/identities/family_access) for one identity, plus
 * any extra tables the specific route under test needs (e.g. `families` for
 * the parameterless `/api/family/summary` lookup).
 */
export function buildAuthFixtures(
  spec: TestIdentitySpec,
  extraTables: FakeFixtures = {},
): FakeFixtures {
  const now = new Date().toISOString();

  const users = [
    {
      id: spec.userId,
      email: null,
      display_name: 'Test User',
      avatar_url: null,
      role: spec.globalRole ?? 'user',
      created_at: now,
      updated_at: now,
    },
  ];

  const identities = [
    {
      id: spec.identityId,
      user_id: spec.userId,
      provider: 'telegram',
      provider_user_id: '123456',
      provider_username: null,
      display_name: 'Test User',
      avatar_url: null,
      timezone: null,
      is_active: true,
      created_at: now,
      updated_at: now,
    },
  ];

  const family_access = (spec.familyAccess ?? []).map((fa, index) => ({
    id: `test-access-${index}`,
    identity_id: spec.identityId,
    family_id: fa.familyId,
    role: fa.role,
    status: fa.status ?? 'active',
    person_id: null,
    granted_by: 'admin',
    granted_at: now,
    revoked_at: null,
    revoked_by: null,
    revoke_reason: null,
    notes: null,
    created_at: now,
    updated_at: now,
  }));

  return { ...extraTables, users, identities, family_access };
}

/**
 * Sign a real session JWT for the given identity spec, using the fixed test
 * secret. Pair with `createAuthPlugin({ secret: TEST_JWT_SECRET, dbClient })`
 * where `dbClient` is built from `buildAuthFixtures(spec, ...)`.
 */
export async function signTestToken(spec: TestIdentitySpec): Promise<string> {
  return createSessionToken(
    {
      userId: spec.userId,
      identityId: spec.identityId,
      role: spec.globalRole ?? 'user',
    },
    TEST_JWT_SECRET,
  );
}

export function authHeader(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

export { createFakeDbClient };
