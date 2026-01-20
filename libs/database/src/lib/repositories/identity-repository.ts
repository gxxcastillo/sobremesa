import { SupabaseClient } from '@supabase/supabase-js';
import type { Identity, ChatProvider } from '@sobremesa/shared-types';
import { getServiceClient } from '../client.js';
import { mapRowToCamelCase } from '../base-repository.js';

/**
 * Repository for global chat provider identities.
 *
 * Identities are global - one per provider account (e.g., Telegram user 12345).
 * They optionally link to users table for cross-provider account linking.
 * Per-family relationships (including person claims) are in family_access.
 */
export class IdentityRepository {
  protected tableName = 'identities';
  protected client: SupabaseClient;

  constructor(client?: SupabaseClient) {
    this.client = client ?? getServiceClient();
  }

  // ===========================================================================
  // Core Identity Methods (Global - no family_id)
  // ===========================================================================

  /**
   * Find an identity by ID.
   */
  async findById(id: string): Promise<Identity | null> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      throw new Error(`Failed to find identity: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Find an identity by provider and provider user ID.
   * Identities are global - unique on (provider, provider_user_id).
   */
  async findByProviderUserId(
    provider: ChatProvider,
    providerUserId: string,
  ): Promise<Identity | null> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('provider', provider)
      .eq('provider_user_id', providerUserId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      throw new Error(
        `Failed to find identity by provider user ID: ${error.message}`,
      );
    }

    return this.mapFromDb(data);
  }

  /**
   * Find an identity by Telegram user ID.
   * Convenience method for Telegram-specific lookups.
   */
  async findByTelegramUserId(telegramUserId: number): Promise<Identity | null> {
    return this.findByProviderUserId('telegram', String(telegramUserId));
  }

  /**
   * Find all identities linked to a user.
   */
  async findByUserId(userId: string): Promise<Identity[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true);

    if (error) {
      throw new Error(`Failed to find identities by user: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find or create a global identity, updating profile if changed.
   */
  async findOrCreate(
    provider: ChatProvider,
    providerUserId: string,
    providerUsername?: string | null,
    displayName?: string | null,
    avatarUrl?: string | null,
  ): Promise<{ identity: Identity; isNew: boolean }> {
    // Try to find existing identity
    const existing = await this.findByProviderUserId(provider, providerUserId);

    if (existing) {
      // Update profile if changed
      const needsUpdate =
        (displayName && displayName !== existing.displayName) ||
        (providerUsername && providerUsername !== existing.providerUsername) ||
        (avatarUrl && avatarUrl !== existing.avatarUrl);

      if (needsUpdate) {
        const updated = await this.updateProfile(existing.id, {
          providerUsername,
          displayName,
          avatarUrl,
        });
        return { identity: updated || existing, isNew: false };
      }

      return { identity: existing, isNew: false };
    }

    // Create new identity
    const identity = await this.create({
      provider,
      providerUserId,
      providerUsername,
      displayName: displayName || `User ${providerUserId}`,
      avatarUrl,
      isActive: true,
    });

    return { identity, isNew: true };
  }

  /**
   * Create a new identity.
   */
  async create(data: {
    userId?: string;
    provider: ChatProvider;
    providerUserId: string;
    providerUsername?: string | null;
    displayName?: string | null;
    avatarUrl?: string | null;
    isActive?: boolean;
  }): Promise<Identity> {
    const { data: row, error } = await this.client
      .from(this.tableName)
      .insert({
        user_id: data.userId || null,
        provider: data.provider,
        provider_user_id: data.providerUserId,
        provider_username: data.providerUsername || null,
        display_name: data.displayName || `User ${data.providerUserId}`,
        avatar_url: data.avatarUrl || null,
        is_active: data.isActive ?? true,
        last_login_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create identity: ${error.message}`);
    }

    return this.mapFromDb(row);
  }

  /**
   * Update an identity's profile.
   */
  async updateProfile(
    id: string,
    updates: {
      providerUsername?: string | null;
      displayName?: string | null;
      avatarUrl?: string | null;
    },
  ): Promise<Identity | null> {
    const updateData: Record<string, unknown> = {
      last_login_at: new Date().toISOString(),
    };

    if (updates.providerUsername !== undefined) {
      updateData.provider_username = updates.providerUsername;
    }
    if (updates.displayName !== undefined) {
      updateData.display_name = updates.displayName;
    }
    if (updates.avatarUrl !== undefined) {
      updateData.avatar_url = updates.avatarUrl;
    }

    const { data, error } = await this.client
      .from(this.tableName)
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      return null;
    }

    return this.mapFromDb(data);
  }

  /**
   * Update last login timestamp.
   */
  async updateLastLogin(id: string): Promise<void> {
    await this.client
      .from(this.tableName)
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', id);
  }

  /**
   * Link an identity to a user account.
   */
  async linkToUser(identityId: string, userId: string): Promise<Identity> {
    const { data, error } = await this.client
      .from(this.tableName)
      .update({ user_id: userId })
      .eq('id', identityId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to link identity to user: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Deactivate an identity.
   */
  async deactivate(id: string): Promise<Identity> {
    const { data, error } = await this.client
      .from(this.tableName)
      .update({ is_active: false })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to deactivate identity: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Find all active identities.
   */
  async findAllActive(): Promise<Identity[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('is_active', true)
      .order('display_name', { ascending: true });

    if (error) {
      throw new Error(`Failed to find active identities: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  // ===========================================================================
  // DB Mapping
  // ===========================================================================

  protected mapFromDb(row: Record<string, unknown>): Identity {
    return mapRowToCamelCase<Identity>(row);
  }
}
