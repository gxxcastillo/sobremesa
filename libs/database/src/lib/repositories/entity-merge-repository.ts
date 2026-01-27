import { SupabaseClient } from '@supabase/supabase-js';
import type { EntityMerge } from '@sobremesa/shared-types';
import {
  BaseRepository,
  mapRowToCamelCase,
  mapRecordToSnakeCase,
} from '../base-repository.js';

/**
 * Repository for entity merges (active merges, deletable to undo).
 */
export class EntityMergeRepository extends BaseRepository<EntityMerge> {
  constructor(client?: SupabaseClient) {
    super('entity_merges', client);
  }

  /**
   * Find merges by source entity.
   */
  async findBySource(
    familyId: string,
    entityType: string,
    entityId: string,
  ): Promise<EntityMerge[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('source_entity_type', entityType)
      .eq('source_entity_id', entityId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find merges by source: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find merges by target entity.
   */
  async findByTarget(
    familyId: string,
    entityType: string,
    entityId: string,
  ): Promise<EntityMerge[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('target_entity_type', entityType)
      .eq('target_entity_id', entityId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find merges by target: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find a merge for a specific source entity (should be unique).
   */
  async findOneBySource(
    familyId: string,
    entityType: string,
    entityId: string,
  ): Promise<EntityMerge | null> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('source_entity_type', entityType)
      .eq('source_entity_id', entityId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to find merge by source: ${error.message}`);
    }

    return data ? this.mapFromDb(data) : null;
  }

  /**
   * Find all merges for a family.
   */
  override async findAll(familyId: string): Promise<EntityMerge[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find merges: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Create a new entity merge.
   */
  async createMerge(
    familyId: string,
    sourceEntityId: string,
    sourceEntityType: 'person' | 'place' | 'event' | 'story',
    targetEntityId: string,
    targetEntityType: 'person' | 'place' | 'event' | 'story',
    options: {
      mergeStrategy?:
        | 'fuzzy_match'
        | 'identity_claim'
        | 'manual'
        | 'llm_resolved';
      confidence?: number;
      triggerEventId?: string;
      mergedBy?: 'registrar' | 'curator' | 'admin' | 'llm_resolver';
      mergeReason?: string;
    },
  ): Promise<EntityMerge> {
    const record: Omit<EntityMerge, 'id' | 'createdAt'> = {
      familyId,
      sourceEntityId,
      sourceEntityType,
      targetEntityId,
      targetEntityType,
      mergeStrategy: options.mergeStrategy,
      confidence: options.confidence,
      triggerEventId: options.triggerEventId,
      mergedBy: options.mergedBy,
      mergeReason: options.mergeReason,
    };

    return await this.insert(record);
  }

  /**
   * Delete a merge (to undo).
   */
  async deleteMerge(familyId: string, mergeId: string): Promise<void> {
    const { error } = await this.client
      .from(this.tableName)
      .delete()
      .eq('family_id', familyId)
      .eq('id', mergeId);

    if (error) {
      throw new Error(`Failed to delete merge: ${error.message}`);
    }
  }

  /**
   * Get the merge chain for an entity (all entities merged into this one).
   * Calls database function get_entity_merge_chain().
   * Returns array of entity IDs including the target entity itself.
   */
  async getMergeChain(
    familyId: string,
    entityId: string,
    entityType: string,
  ): Promise<string[]> {
    const { data, error } = await this.client.rpc('get_entity_merge_chain', {
      p_entity_id: entityId,
      p_entity_type: entityType,
      p_family_id: familyId,
    });

    if (error) {
      throw new Error(`Failed to get merge chain: ${error.message}`);
    }

    // Database function returns table with entity_id column
    return (data || []).map((row: { entity_id: string }) => row.entity_id);
  }

  protected override mapFromDb(row: Record<string, unknown>): EntityMerge {
    return mapRowToCamelCase<EntityMerge>(row);
  }

  protected override mapToDb(record: EntityMerge): Record<string, unknown> {
    return mapRecordToSnakeCase(record as unknown as Record<string, unknown>);
  }
}
