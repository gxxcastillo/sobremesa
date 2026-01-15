import { SupabaseClient } from '@supabase/supabase-js';
import type { Identity, ChatProvider } from '@sobremesa/shared-types';
import {
  BaseRepository,
  mapRowToCamelCase,
  mapRecordToSnakeCase,
} from '../base-repository.js';

/**
 * Repository for chat provider identities (e.g., Telegram users).
 */
export class IdentityRepository extends BaseRepository<Identity> {
  constructor(client?: SupabaseClient) {
    super('identities', client);
  }

  /**
   * Find an identity by provider user ID.
   */
  async findByProviderUserId(
    familyId: string,
    source: ChatProvider,
    providerUserId: string,
  ): Promise<Identity | null> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('source', source)
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
   * Find or create an identity, updating display name/username if changed.
   */
  async findOrCreate(
    familyId: string,
    source: ChatProvider,
    providerUserId: string,
    displayName?: string,
    username?: string,
  ): Promise<Identity> {
    // Try to find existing identity
    const existing = await this.findByProviderUserId(
      familyId,
      source,
      providerUserId,
    );

    if (existing) {
      // Update display name/username if changed
      const needsUpdate =
        (displayName && displayName !== existing.displayName) ||
        (username && username !== existing.username);

      if (needsUpdate) {
        return await this.update(familyId, existing.id, {
          displayName: displayName ?? existing.displayName,
          username: username ?? existing.username,
        });
      }

      return existing;
    }

    // Create new identity
    const record: Omit<Identity, 'id' | 'createdAt' | 'updatedAt'> = {
      familyId,
      source,
      providerUserId,
      displayName,
      username,
      isActive: true,
    };

    return await this.insert(record);
  }

  /**
   * Link an identity to a person.
   */
  async linkToPerson(
    familyId: string,
    identityId: string,
    personId: string,
  ): Promise<Identity> {
    return await this.update(familyId, identityId, {
      personId,
    } as Partial<Identity>);
  }

  /**
   * Unlink an identity from a person.
   */
  async unlinkFromPerson(
    familyId: string,
    identityId: string,
  ): Promise<Identity> {
    const { data, error } = await this.client
      .from(this.tableName)
      .update({ person_id: null })
      .eq('family_id', familyId)
      .eq('id', identityId)
      .select()
      .single();

    if (error) {
      throw new Error(
        `Failed to unlink identity from person: ${error.message}`,
      );
    }

    return this.mapFromDb(data);
  }

  /**
   * Find all identities linked to a person.
   */
  async findByPersonId(
    familyId: string,
    personId: string,
  ): Promise<Identity[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('person_id', personId)
      .eq('is_active', true);

    if (error) {
      throw new Error(`Failed to find identities by person: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find all active identities for a family.
   */
  async findAllActive(familyId: string): Promise<Identity[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('is_active', true)
      .order('display_name', { ascending: true });

    if (error) {
      throw new Error(`Failed to find active identities: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  protected mapFromDb(row: Record<string, unknown>): Identity {
    return mapRowToCamelCase<Identity>(row);
  }

  protected mapToDb(record: Identity): Record<string, unknown> {
    return mapRecordToSnakeCase(record as unknown as Record<string, unknown>);
  }
}
