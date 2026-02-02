import type { DatabaseClient } from '@sobremesa/database';
/**
 * User Repository
 *
 * Manages users table operations for global user accounts
 */

import { mapRowToCamelCase } from '@sobremesa/database';
import type { User } from '../types';

export class UserRepository {
  private client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.client = client;
  }

  /**
   * Find user by ID
   */
  async findById(id: string): Promise<User | null> {
    const client = this.client;

    const { data, error } = await client
      .from('users')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      // PGRST116 = "not found" - return null
      if (error.code === 'PGRST116') {
        return null;
      }
      // Other errors are real DB errors - throw
      throw new Error(`Failed to find user: ${error.message}`);
    }

    if (!data) {
      return null;
    }

    return mapRowToCamelCase(data) as User;
  }

  /**
   * Find user by email
   */
  async findByEmail(email: string): Promise<User | null> {
    const client = this.client;

    const { data, error } = await client
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (error) {
      // PGRST116 = "not found" - return null
      if (error.code === 'PGRST116') {
        return null;
      }
      // Other errors are real DB errors - throw
      throw new Error(`Failed to find user by email: ${error.message}`);
    }

    if (!data) {
      return null;
    }

    return mapRowToCamelCase(data) as User;
  }

  /**
   * Find user by identity ID
   */
  async findByIdentityId(identityId: string): Promise<User | null> {
    const client = this.client;

    const { data, error } = await client
      .from('identities')
      .select('user_id')
      .eq('id', identityId)
      .single();

    if (error) {
      // PGRST116 = "not found" - return null
      if (error.code === 'PGRST116') {
        return null;
      }
      // Other errors are real DB errors - throw
      throw new Error(`Failed to find identity: ${error.message}`);
    }

    if (!data || !data.user_id) {
      return null;
    }

    return this.findById(data.user_id);
  }

  /**
   * Create a new user
   */
  async create(params: {
    displayName?: string | null;
    avatarUrl?: string | null;
    email?: string | null;
  }): Promise<User> {
    const client = this.client;

    const { data, error } = await client
      .from('users')
      .insert({
        display_name: params.displayName || null,
        avatar_url: params.avatarUrl || null,
        email: params.email || null,
        role: 'user',
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create user: ${error.message}`);
    }

    return mapRowToCamelCase(data) as User;
  }

  /**
   * Update user profile
   */
  async update(
    id: string,
    updates: {
      displayName?: string | null;
      avatarUrl?: string | null;
      email?: string | null;
    },
  ): Promise<User | null> {
    const client = this.client;

    const updateData: Record<string, unknown> = {};

    if (updates.displayName !== undefined) {
      updateData.display_name = updates.displayName;
    }
    if (updates.avatarUrl !== undefined) {
      updateData.avatar_url = updates.avatarUrl;
    }
    if (updates.email !== undefined) {
      updateData.email = updates.email;
    }

    // Skip if nothing to update
    if (Object.keys(updateData).length === 0) {
      return this.findById(id);
    }

    const { data, error } = await client
      .from('users')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      // PGRST116 = "not found" - return null
      if (error.code === 'PGRST116') {
        return null;
      }
      // Other errors are real DB errors - throw
      throw new Error(`Failed to update user: ${error.message}`);
    }

    if (!data) {
      return null;
    }

    return mapRowToCamelCase(data) as User;
  }

  /**
   * Sync user profile from identity (updates user if profile fields are empty)
   * This is used when a user logs in to potentially update their canonical profile
   */
  async syncProfileFromIdentity(
    userId: string,
    identityDisplayName?: string | null,
    identityAvatarUrl?: string | null,
  ): Promise<User | null> {
    const user = await this.findById(userId);
    if (!user) {
      return null;
    }

    // Only update if the user's field is empty and identity has a value
    const updates: { displayName?: string | null; avatarUrl?: string | null } =
      {};

    if (!user.displayName && identityDisplayName) {
      updates.displayName = identityDisplayName;
    }
    if (!user.avatarUrl && identityAvatarUrl) {
      updates.avatarUrl = identityAvatarUrl;
    }

    if (Object.keys(updates).length === 0) {
      return user;
    }

    return this.update(userId, updates);
  }

  /**
   * Check if user is super admin
   */
  async isSuperAdmin(id: string): Promise<boolean> {
    const user = await this.findById(id);
    return user?.role === 'super_admin';
  }

  // ===========================================================================
  // Deprecated methods - for backward compatibility
  // ===========================================================================

  /** @deprecated Use findByIdentityId instead */
  async findByAuthIdentityId(authIdentityId: string): Promise<User | null> {
    return this.findByIdentityId(authIdentityId);
  }

  /** @deprecated Use syncProfileFromIdentity instead */
  async syncProfileFromAuthIdentity(
    userId: string,
    authIdentityDisplayName?: string | null,
    authIdentityAvatarUrl?: string | null,
  ): Promise<User | null> {
    return this.syncProfileFromIdentity(
      userId,
      authIdentityDisplayName,
      authIdentityAvatarUrl,
    );
  }
}
