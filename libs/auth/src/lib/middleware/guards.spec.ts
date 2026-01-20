import { describe, it, expect } from 'vitest';
import { hasAccessToFamily } from './guards';
import type { AuthContext, FamilyAccess, FamilyRole } from '../types';

describe('guards', () => {
  describe('hasAccessToFamily', () => {
    // Helper to create a complete FamilyAccess object with defaults
    const createFamilyAccess = (
      overrides: Partial<FamilyAccess> & { familyId: string; role: FamilyRole },
    ): FamilyAccess => ({
      id: `access-${overrides.familyId}`,
      identityId: 'identity-123',
      grantedAt: new Date(),
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
      notes: null,
      status: 'active',
      grantedBy: 'system',
      personId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    });

    const mockAuthContext = (
      overrides?: Partial<AuthContext>,
    ): AuthContext => ({
      isAuthenticated: true,
      isSuperAdmin: false,
      user: {
        id: 'user-123',
        email: 'test@example.com',
        displayName: 'Test User',
        avatarUrl: null,
        role: 'user',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      identity: {
        id: 'identity-123',
        userId: 'user-123',
        provider: 'telegram',
        providerUserId: '123456',
        displayName: 'Test User',
        avatarUrl: undefined,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      familyAccess: [],
      ...overrides,
    });

    it('should return true for super admin regardless of family access', () => {
      const auth = mockAuthContext({ isSuperAdmin: true });
      const result = hasAccessToFamily(auth, 'any-family-id');
      expect(result).toBe(true);
    });

    it('should return false if not authenticated', () => {
      const auth = mockAuthContext({
        isAuthenticated: false,
        user: null,
        identity: null,
      });
      const result = hasAccessToFamily(auth, 'family-123');
      expect(result).toBe(false);
    });

    it('should return false if user is null', () => {
      const auth = mockAuthContext({ user: null });
      const result = hasAccessToFamily(auth, 'family-123');
      expect(result).toBe(false);
    });

    it('should return false if identity is null', () => {
      const auth = mockAuthContext({ identity: null });
      const result = hasAccessToFamily(auth, 'family-123');
      expect(result).toBe(false);
    });

    it('should return true if user has access to the family', () => {
      const auth = mockAuthContext({
        familyAccess: [
          createFamilyAccess({
            familyId: 'family-123',
            role: 'member',
          }),
        ],
      });
      const result = hasAccessToFamily(auth, 'family-123');
      expect(result).toBe(true);
    });

    it('should return false if user does not have access to the family', () => {
      const auth = mockAuthContext({
        familyAccess: [
          createFamilyAccess({
            familyId: 'family-456',
            role: 'member',
          }),
        ],
      });
      const result = hasAccessToFamily(auth, 'family-123');
      expect(result).toBe(false);
    });

    it('should return true if user has required minimum role', () => {
      const auth = mockAuthContext({
        familyAccess: [
          createFamilyAccess({
            familyId: 'family-123',
            role: 'admin',
          }),
        ],
      });
      const result = hasAccessToFamily(auth, 'family-123', 'member');
      expect(result).toBe(true);
    });

    it('should return false if user does not have minimum role', () => {
      const auth = mockAuthContext({
        familyAccess: [
          createFamilyAccess({
            familyId: 'family-123',
            role: 'viewer',
          }),
        ],
      });
      const result = hasAccessToFamily(auth, 'family-123', 'member');
      expect(result).toBe(false);
    });

    it('should return true if user has exact minimum role', () => {
      const auth = mockAuthContext({
        familyAccess: [
          createFamilyAccess({
            familyId: 'family-123',
            role: 'member',
          }),
        ],
      });
      const result = hasAccessToFamily(auth, 'family-123', 'member');
      expect(result).toBe(true);
    });

    it('should handle role hierarchy correctly (admin > member > viewer)', () => {
      const authViewer = mockAuthContext({
        familyAccess: [
          createFamilyAccess({
            familyId: 'family-123',
            role: 'viewer',
          }),
        ],
      });

      const authMember = mockAuthContext({
        familyAccess: [
          createFamilyAccess({
            familyId: 'family-123',
            role: 'member',
          }),
        ],
      });

      const authAdmin = mockAuthContext({
        familyAccess: [
          createFamilyAccess({
            familyId: 'family-123',
            role: 'admin',
          }),
        ],
      });

      // Viewer should not have admin access
      expect(hasAccessToFamily(authViewer, 'family-123', 'admin')).toBe(false);

      // Member should not have admin access
      expect(hasAccessToFamily(authMember, 'family-123', 'admin')).toBe(false);

      // Admin should have admin access
      expect(hasAccessToFamily(authAdmin, 'family-123', 'admin')).toBe(true);

      // Admin should have member access
      expect(hasAccessToFamily(authAdmin, 'family-123', 'member')).toBe(true);

      // Admin should have viewer access
      expect(hasAccessToFamily(authAdmin, 'family-123', 'viewer')).toBe(true);

      // Member should have viewer access
      expect(hasAccessToFamily(authMember, 'family-123', 'viewer')).toBe(true);
    });

    it('should handle multiple family access entries correctly', () => {
      const auth = mockAuthContext({
        familyAccess: [
          createFamilyAccess({
            familyId: 'family-123',
            role: 'viewer',
          }),
          createFamilyAccess({
            familyId: 'family-456',
            role: 'admin',
          }),
        ],
      });

      // Should find the correct family access
      expect(hasAccessToFamily(auth, 'family-123')).toBe(true);
      expect(hasAccessToFamily(auth, 'family-456')).toBe(true);
      expect(hasAccessToFamily(auth, 'family-123', 'viewer')).toBe(true);
      expect(hasAccessToFamily(auth, 'family-456', 'admin')).toBe(true);

      // Should respect role requirements
      expect(hasAccessToFamily(auth, 'family-123', 'admin')).toBe(false);
      expect(hasAccessToFamily(auth, 'family-456', 'member')).toBe(true);
    });
  });
});
