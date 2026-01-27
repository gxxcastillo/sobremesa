import { SupabaseClient } from '@supabase/supabase-js';
import type { ClaimEntity } from '@sobremesa/shared-types';
import { getServiceClient } from '../client.js';
import { mapRowToCamelCase, mapRecordToSnakeCase } from '../base-repository.js';

/**
 * Repository for claim-entity relationships (many-to-many with identity resolution).
 * Note: Does not extend BaseRepository since this is a join table with composite key.
 */
export class ClaimEntityRepository {
  protected client: SupabaseClient;
  protected tableName = 'claim_entities';

  constructor(client?: SupabaseClient) {
    this.client = client || getServiceClient();
  }

  /**
   * Find entities for a claim.
   */
  async findByClaim(familyId: string, claimId: string): Promise<ClaimEntity[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('claim_id', claimId)
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error(`Failed to find claim entities: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find claims for an entity.
   */
  async findByEntity(
    familyId: string,
    entityType: string,
    entityId: string,
  ): Promise<ClaimEntity[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find entity claims: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find unresolved identity claims for a family.
   * These are claim_entities where the parent claim has claim_type='identity'
   * and resolved=FALSE.
   */
  async findUnresolvedIdentityClaims(familyId: string): Promise<ClaimEntity[]> {
    // Join with claims table to filter by claim_type='identity'
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*, claims!inner(claim_type)')
      .eq('family_id', familyId)
      .eq('resolved', false)
      .eq('claims.claim_type', 'identity')
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(
        `Failed to find unresolved identity claims: ${error.message}`,
      );
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find all claims for an entity, including claims about merged predecessors.
   * Uses the get_entity_merge_chain function to find all entity IDs in the merge chain.
   *
   * @param familyId - Family ID
   * @param entityId - Entity ID (will include merged predecessors)
   * @param entityType - Entity type ('person', 'place', 'event', 'story')
   * @returns Array of claims with full claim data
   */
  async findClaimsForEntityIncludingMerged(
    familyId: string,
    entityId: string,
    entityType: string,
  ): Promise<any[]> {
    // Call the database function to get merge chain
    const { data: mergeChain, error: mergeError } = await this.client.rpc(
      'get_entity_merge_chain',
      {
        p_entity_id: entityId,
        p_entity_type: entityType,
        p_family_id: familyId,
      },
    );

    if (mergeError) {
      throw new Error(`Failed to get merge chain: ${mergeError.message}`);
    }

    const entityIds = mergeChain?.map((row: any) => row.entity_id) || [
      entityId,
    ];

    // Query claim_entities for all entity IDs in chain, join with claims
    const { data, error } = await this.client
      .from(this.tableName)
      .select('claims!inner(*)')
      .eq('family_id', familyId)
      .eq('entity_type', entityType)
      .in('entity_id', entityIds);

    if (error) {
      throw new Error(`Failed to find claims for entity: ${error.message}`);
    }

    // Extract claims from the join result
    return (data || []).map((row: any) => row.claims);
  }

  /**
   * Link a claim to an entity.
   */
  async link(
    familyId: string,
    claimId: string,
    entityId: string,
    entityType: 'person' | 'place' | 'event' | 'story' | 'relationship',
    options?: {
      role?: string;
      resolved?: boolean;
      entityMergeId?: string;
      relationshipMetadata?: Record<string, unknown>;
    },
  ): Promise<ClaimEntity> {
    const record: Omit<ClaimEntity, 'id' | 'createdAt'> = {
      familyId,
      claimId,
      entityId,
      entityType,
      role: options?.role,
      resolved: options?.resolved,
      entityMergeId: options?.entityMergeId,
      relationshipMetadata: options?.relationshipMetadata,
    };

    const { data, error } = await this.client
      .from(this.tableName)
      .insert(this.mapToDb(record))
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to link claim to entity: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Mark identity claim entities as resolved.
   */
  async markIdentityResolved(
    familyId: string,
    claimId: string,
    entityMergeId: string,
  ): Promise<void> {
    const { error } = await this.client
      .from(this.tableName)
      .update({
        resolved: true,
        entity_merge_id: entityMergeId,
      })
      .eq('family_id', familyId)
      .eq('claim_id', claimId);

    if (error) {
      throw new Error(`Failed to mark identity as resolved: ${error.message}`);
    }
  }

  /**
   * Unlink a claim from an entity.
   */
  async unlink(
    familyId: string,
    claimId: string,
    entityId: string,
    entityType: string,
  ): Promise<void> {
    const { error } = await this.client
      .from(this.tableName)
      .delete()
      .eq('family_id', familyId)
      .eq('claim_id', claimId)
      .eq('entity_id', entityId)
      .eq('entity_type', entityType);

    if (error) {
      throw new Error(`Failed to unlink claim from entity: ${error.message}`);
    }
  }

  private mapFromDb(row: Record<string, unknown>): ClaimEntity {
    return mapRowToCamelCase<ClaimEntity>(row);
  }

  private mapToDb(record: Partial<ClaimEntity>): Record<string, unknown> {
    return mapRecordToSnakeCase(record as unknown as Record<string, unknown>);
  }
}
