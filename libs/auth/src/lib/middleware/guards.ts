/**
 * Auth Guards for Elysia
 *
 * Middleware functions that enforce authentication and authorization
 * requirements on routes.
 */

import { Elysia } from 'elysia';
import type { AuthContext, FamilyRole } from '../types';
import { FamilyAccessRepository } from '../repositories/family-access-repository';

/**
 * Require authentication guard
 *
 * Returns 401 if user is not authenticated
 */
export const requireAuth = new Elysia({ name: 'require-auth' })
  .guard({
    beforeHandle(context) {
      const { auth, set } = context as unknown as {
        auth: AuthContext;
        set: { status: number };
      };
      if (!auth?.isAuthenticated || !auth?.user || !auth?.identity) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
      return undefined;
    },
  })
  .as('scoped');

/**
 * Require super admin role guard
 *
 * Returns 401 if not authenticated, 403 if not super admin
 */
export const requireSuperAdmin = new Elysia({ name: 'require-super-admin' })
  .guard({
    beforeHandle(context) {
      const { auth, set } = context as unknown as {
        auth: AuthContext;
        set: { status: number };
      };
      if (!auth?.isAuthenticated || !auth?.user || !auth?.identity) {
        set.status = 401;
        return { error: 'Authentication required' };
      }

      if (!auth.isSuperAdmin) {
        set.status = 403;
        return { error: 'Super admin access required' };
      }
      return undefined;
    },
  })
  .as('scoped');

/**
 * Create a guard that requires membership in a specific family
 *
 * @param familyIdParam - The name of the route param containing the family ID
 * @param minimumRole - Optional minimum role required (default: any membership)
 */
export function createFamilyMemberGuard(
  familyIdParam = 'familyId',
  minimumRole?: FamilyRole,
) {
  return new Elysia({ name: `require-family-member-${familyIdParam}` })
    .guard({
      async beforeHandle(context) {
        const { auth, params, set } = context as unknown as {
          auth: AuthContext;
          params: Record<string, string>;
          set: { status: number };
        };

        if (!auth?.isAuthenticated || !auth?.user || !auth?.identity) {
          set.status = 401;
          return { error: 'Authentication required' };
        }

        const familyId = params[familyIdParam];
        if (!familyId) {
          set.status = 400;
          return { error: 'Family ID is required' };
        }

        // Super admins have access to all families
        if (auth.isSuperAdmin) {
          return undefined;
        }

        // Check access
        const access = auth.familyAccess.find((a) => a.familyId === familyId);

        if (!access) {
          set.status = 403;
          return { error: 'Access denied: no access to this family' };
        }

        // Check minimum role if specified
        if (minimumRole) {
          const roleHierarchy: Record<FamilyRole, number> = {
            viewer: 1,
            member: 2,
            admin: 3,
          };

          if (roleHierarchy[access.role] < roleHierarchy[minimumRole]) {
            set.status = 403;
            return {
              error: `Access denied: ${minimumRole} role required`,
            };
          }
        }
        return undefined;
      },
    })
    .as('scoped');
}

/**
 * Pre-built guard for family member access (any role)
 */
export const requireFamilyMember = createFamilyMemberGuard('familyId');

/**
 * Pre-built guard for family admin access
 */
export const requireFamilyAdmin = createFamilyMemberGuard('familyId', 'admin');

/**
 * Helper to check if auth context has access to a family
 */
export function hasAccessToFamily(
  auth: AuthContext,
  familyId: string,
  minimumRole?: FamilyRole,
): boolean {
  if (!auth.isAuthenticated || !auth.user || !auth.identity) {
    return false;
  }

  // Super admins have access to all families
  if (auth.isSuperAdmin) {
    return true;
  }

  const access = auth.familyAccess.find((a) => a.familyId === familyId);

  if (!access) {
    return false;
  }

  if (minimumRole) {
    const roleHierarchy: Record<FamilyRole, number> = {
      viewer: 1,
      member: 2,
      admin: 3,
    };

    return roleHierarchy[access.role] >= roleHierarchy[minimumRole];
  }

  return true;
}

/**
 * Get user's role in a family from auth context
 */
export function getFamilyRole(
  auth: AuthContext,
  familyId: string,
): FamilyRole | null {
  if (!auth.isAuthenticated || !auth.user || !auth.identity) {
    return null;
  }

  // Super admins are treated as admin in all families
  if (auth.isSuperAdmin) {
    return 'admin';
  }

  const access = auth.familyAccess.find((a) => a.familyId === familyId);
  return access?.role || null;
}

/**
 * Async helper to check family access when auth context
 * might not have access records loaded
 */
export async function checkFamilyAccess(
  identityId: string,
  familyId: string,
  minimumRole?: FamilyRole,
): Promise<boolean> {
  const accessRepo = new FamilyAccessRepository();
  const role = await accessRepo.getRole(identityId, familyId);

  if (!role) {
    return false;
  }

  if (minimumRole) {
    const roleHierarchy: Record<FamilyRole, number> = {
      viewer: 1,
      member: 2,
      admin: 3,
    };

    return roleHierarchy[role] >= roleHierarchy[minimumRole];
  }

  return true;
}
