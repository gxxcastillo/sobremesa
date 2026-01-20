/**
 * FamilyAccess Repository
 *
 * Manages family_access table operations for controlling who can access
 * a family via the web/Studio app. Also stores person claims.
 */

import { getServiceClient, mapRowToCamelCase } from '@sobremesa/database';
import type {
  FamilyAccess,
  FamilyRole,
  FamilyWithRole,
  AccessGrantedBy,
  FamilyAccessStatus,
} from '../types';

export class FamilyAccessRepository {
  /**
   * Find access by identity ID and family ID
   */
  async findByIdentityAndFamily(
    identityId: string,
    familyId: string,
    options?: {
      includeInactive?: boolean;
      statusFilter?: FamilyAccessStatus[];
    },
  ): Promise<FamilyAccess | null> {
    const client = getServiceClient();

    let query = client
      .from('family_access')
      .select('*')
      .eq('identity_id', identityId)
      .eq('family_id', familyId);

    if (!options?.includeInactive) {
      if (options?.statusFilter) {
        query = query.in('status', options.statusFilter);
      } else {
        query = query.eq('status', 'active');
      }
    }

    const { data, error } = await query.single();

    if (error || !data) {
      return null;
    }

    return mapRowToCamelCase(data) as FamilyAccess;
  }

  /**
   * Find all access records for an identity
   */
  async findByIdentity(
    identityId: string,
    options?: {
      includeInactive?: boolean;
      statusFilter?: FamilyAccessStatus[];
    },
  ): Promise<FamilyAccess[]> {
    const client = getServiceClient();

    let query = client
      .from('family_access')
      .select('*')
      .eq('identity_id', identityId)
      .order('granted_at', { ascending: false });

    if (!options?.includeInactive) {
      if (options?.statusFilter) {
        query = query.in('status', options.statusFilter);
      } else {
        query = query.eq('status', 'active');
      }
    }

    const { data, error } = await query;

    if (error || !data) {
      return [];
    }

    return data.map((row) => mapRowToCamelCase(row) as FamilyAccess);
  }

  /**
   * Find all access records for a family
   */
  async findByFamily(
    familyId: string,
    options?: {
      includeInactive?: boolean;
      statusFilter?: FamilyAccessStatus[];
    },
  ): Promise<FamilyAccess[]> {
    const client = getServiceClient();

    let query = client
      .from('family_access')
      .select('*')
      .eq('family_id', familyId)
      .order('granted_at', { ascending: true });

    if (!options?.includeInactive) {
      if (options?.statusFilter) {
        query = query.in('status', options.statusFilter);
      } else {
        query = query.eq('status', 'active');
      }
    }

    const { data, error } = await query;

    if (error || !data) {
      return [];
    }

    return data.map((row) => mapRowToCamelCase(row) as FamilyAccess);
  }

  /**
   * Get all families with roles for an identity (only active access by default)
   */
  async getFamiliesWithRoles(
    identityId: string,
    options?: { statusFilter?: FamilyAccessStatus[] },
  ): Promise<FamilyWithRole[]> {
    const client = getServiceClient();

    let query = client
      .from('family_access')
      .select(
        `
        family_id,
        role,
        status,
        person_id,
        granted_at,
        families!inner(name)
      `,
      )
      .eq('identity_id', identityId)
      .order('granted_at', { ascending: false });

    if (options?.statusFilter) {
      query = query.in('status', options.statusFilter);
    } else {
      query = query.eq('status', 'active');
    }

    const { data, error } = await query;

    if (error || !data) {
      return [];
    }

    return data.map((row) => ({
      familyId: row.family_id,
      familyName: (row.families as unknown as { name: string }).name,
      role: row.role as FamilyRole,
      status: row.status as FamilyAccessStatus,
      personId: row.person_id || null,
      grantedAt: new Date(row.granted_at),
    }));
  }

  /**
   * Create a new access record
   */
  async create(
    identityId: string,
    familyId: string,
    role: FamilyRole,
    grantedBy: AccessGrantedBy,
    options?: {
      status?: FamilyAccessStatus;
      personId?: string;
      notes?: string;
    },
  ): Promise<FamilyAccess> {
    const client = getServiceClient();

    const { data, error } = await client
      .from('family_access')
      .insert({
        identity_id: identityId,
        family_id: familyId,
        role,
        status: options?.status || 'pending',
        granted_by: grantedBy,
        granted_at: new Date().toISOString(),
        person_id: options?.personId || null,
        notes: options?.notes || null,
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create access: ${error.message}`);
    }

    return mapRowToCamelCase(data) as FamilyAccess;
  }

  /**
   * Create or update access (upsert)
   * - Reactivates revoked/suspended access if found
   * - Only upgrades role, never downgrades
   * - Sets status to 'active' when granted via web login or access pass
   */
  async upsert(
    identityId: string,
    familyId: string,
    role: FamilyRole,
    grantedBy: AccessGrantedBy,
    options?: {
      status?: FamilyAccessStatus;
      personId?: string;
      notes?: string;
    },
  ): Promise<FamilyAccess> {
    // Check for existing access (including inactive)
    const existing = await this.findByIdentityAndFamily(identityId, familyId, {
      includeInactive: true,
    });

    // Determine status based on grantedBy
    const newStatus =
      options?.status ||
      (['access_pass', 'telegram_login', 'admin'].includes(grantedBy)
        ? 'active'
        : 'pending');

    if (existing) {
      // If inactive and being activated, reactivate
      if (existing.status !== 'active' && newStatus === 'active') {
        return this.activate(existing.id, role);
      }

      // If pending and being activated, activate
      if (existing.status === 'pending' && newStatus === 'active') {
        return this.activate(existing.id, role);
      }

      // Only upgrade role, never downgrade
      const roleHierarchy: Record<FamilyRole, number> = {
        viewer: 1,
        member: 2,
        admin: 3,
      };

      const shouldUpgrade = roleHierarchy[role] > roleHierarchy[existing.role];

      if (shouldUpgrade) {
        return this.updateRole(existing.id, role);
      }

      return existing;
    }

    return this.create(identityId, familyId, role, grantedBy, {
      status: newStatus,
      personId: options?.personId,
      notes: options?.notes,
    });
  }

  /**
   * Update access role
   */
  async updateRole(accessId: string, role: FamilyRole): Promise<FamilyAccess> {
    const client = getServiceClient();

    const { data, error } = await client
      .from('family_access')
      .update({ role })
      .eq('id', accessId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update access role: ${error.message}`);
    }

    return mapRowToCamelCase(data) as FamilyAccess;
  }

  /**
   * Update status (activate, revoke, suspend)
   */
  async updateStatus(
    accessId: string,
    status: FamilyAccessStatus,
    options?: {
      revokedBy?: string;
      reason?: string;
    },
  ): Promise<FamilyAccess> {
    const client = getServiceClient();

    const updateData: Record<string, unknown> = { status };

    if (status === 'revoked' || status === 'suspended') {
      updateData.revoked_at = new Date().toISOString();
      if (options?.revokedBy) {
        updateData.revoked_by = options.revokedBy;
      }
      if (options?.reason) {
        updateData.revoke_reason = options.reason;
      }
    } else if (status === 'active') {
      updateData.revoked_at = null;
      updateData.revoked_by = null;
      updateData.revoke_reason = null;
    }

    const { data, error } = await client
      .from('family_access')
      .update(updateData)
      .eq('id', accessId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update access status: ${error.message}`);
    }

    return mapRowToCamelCase(data) as FamilyAccess;
  }

  /**
   * Activate access (set status to 'active')
   */
  async activate(
    accessId: string,
    newRole?: FamilyRole,
  ): Promise<FamilyAccess> {
    const client = getServiceClient();

    const updateData: Record<string, unknown> = {
      status: 'active' as FamilyAccessStatus,
      revoked_at: null,
      revoked_by: null,
      revoke_reason: null,
    };

    if (newRole) {
      updateData.role = newRole;
    }

    const { data, error } = await client
      .from('family_access')
      .update(updateData)
      .eq('id', accessId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to activate access: ${error.message}`);
    }

    return mapRowToCamelCase(data) as FamilyAccess;
  }

  /**
   * Revoke access (soft delete)
   */
  async revoke(
    accessId: string,
    revokedByIdentityId: string,
    reason?: string,
  ): Promise<FamilyAccess> {
    return this.updateStatus(accessId, 'revoked', {
      revokedBy: revokedByIdentityId,
      reason,
    });
  }

  /**
   * Suspend access (temporary)
   */
  async suspend(
    accessId: string,
    suspendedByIdentityId: string,
    reason?: string,
  ): Promise<FamilyAccess> {
    return this.updateStatus(accessId, 'suspended', {
      revokedBy: suspendedByIdentityId,
      reason,
    });
  }

  /**
   * Claim person identity in a family
   */
  async claimPerson(
    identityId: string,
    familyId: string,
    personId: string,
  ): Promise<FamilyAccess> {
    const client = getServiceClient();

    const { data, error } = await client
      .from('family_access')
      .update({ person_id: personId })
      .eq('identity_id', identityId)
      .eq('family_id', familyId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to claim person: ${error.message}`);
    }

    return mapRowToCamelCase(data) as FamilyAccess;
  }

  /**
   * Remove person claim
   */
  async unclaimPerson(
    identityId: string,
    familyId: string,
  ): Promise<FamilyAccess> {
    const client = getServiceClient();

    const { data, error } = await client
      .from('family_access')
      .update({ person_id: null })
      .eq('identity_id', identityId)
      .eq('family_id', familyId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to unclaim person: ${error.message}`);
    }

    return mapRowToCamelCase(data) as FamilyAccess;
  }

  /**
   * Delete access record permanently (use revoke() for soft delete)
   */
  async delete(accessId: string): Promise<boolean> {
    const client = getServiceClient();

    const { error } = await client
      .from('family_access')
      .delete()
      .eq('id', accessId);

    return !error;
  }

  /**
   * Delete access by identity and family
   */
  async deleteByIdentityAndFamily(
    identityId: string,
    familyId: string,
  ): Promise<boolean> {
    const client = getServiceClient();

    const { error } = await client
      .from('family_access')
      .delete()
      .eq('identity_id', identityId)
      .eq('family_id', familyId);

    return !error;
  }

  /**
   * Check if user has active access to family
   */
  async hasAccess(identityId: string, familyId: string): Promise<boolean> {
    const access = await this.findByIdentityAndFamily(identityId, familyId);
    return access !== null;
  }

  /**
   * Check if user is admin of family (with active access)
   */
  async isAdmin(identityId: string, familyId: string): Promise<boolean> {
    const access = await this.findByIdentityAndFamily(identityId, familyId);
    return access?.role === 'admin';
  }

  /**
   * Get user's role in family (null if no active access)
   */
  async getRole(
    identityId: string,
    familyId: string,
  ): Promise<FamilyRole | null> {
    const access = await this.findByIdentityAndFamily(identityId, familyId);
    return access?.role || null;
  }

  /**
   * Count users with active access to a family
   */
  async countActiveUsers(familyId: string): Promise<number> {
    const client = getServiceClient();

    const { count, error } = await client
      .from('family_access')
      .select('*', { count: 'exact', head: true })
      .eq('family_id', familyId)
      .eq('status', 'active');

    if (error) {
      return 0;
    }

    return count || 0;
  }

  /**
   * Count admins with active access to a family
   */
  async countAdmins(familyId: string): Promise<number> {
    const client = getServiceClient();

    const { count, error } = await client
      .from('family_access')
      .select('*', { count: 'exact', head: true })
      .eq('family_id', familyId)
      .eq('role', 'admin')
      .eq('status', 'active');

    if (error) {
      return 0;
    }

    return count || 0;
  }

  // ===========================================================================
  // Deprecated methods - for backward compatibility
  // ===========================================================================

  /** @deprecated Use findByIdentityAndFamily instead */
  async findByAuthIdentityAndFamily(
    authIdentityId: string,
    familyId: string,
    includeInactive = false,
  ): Promise<FamilyAccess | null> {
    return this.findByIdentityAndFamily(authIdentityId, familyId, {
      includeInactive,
    });
  }

  /** @deprecated Use findByIdentity instead */
  async findByAuthIdentity(
    authIdentityId: string,
    includeInactive = false,
  ): Promise<FamilyAccess[]> {
    return this.findByIdentity(authIdentityId, { includeInactive });
  }

  /** @deprecated Use activate instead */
  async reactivate(
    accessId: string,
    newRole?: FamilyRole,
  ): Promise<FamilyAccess> {
    return this.activate(accessId, newRole);
  }
}
