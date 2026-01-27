import { SupabaseClient } from '@supabase/supabase-js';
import type { ClaimRelationship } from '@sobremesa/shared-types';
import { getServiceClient } from '../client.js';
import { mapRowToCamelCase, mapRecordToSnakeCase } from '../base-repository.js';

/**
 * Repository for claim-to-claim relationships (supports, contradicts, refines, etc.).
 * Note: Does not extend BaseRepository since this is a join table with composite key.
 */
export class ClaimRelationshipRepository {
  protected client: SupabaseClient;
  protected tableName = 'claim_relationships';

  constructor(client?: SupabaseClient) {
    this.client = client || getServiceClient();
  }

  /**
   * Find relationships for a claim (outgoing).
   */
  async findByClaim(
    familyId: string,
    claimId: string,
  ): Promise<ClaimRelationship[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('claim_id', claimId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find claim relationships: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find relationships pointing to a claim (incoming).
   */
  async findByRelatedClaim(
    familyId: string,
    relatedClaimId: string,
  ): Promise<ClaimRelationship[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('related_claim_id', relatedClaimId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find related claims: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find relationships by type.
   */
  async findByType(
    familyId: string,
    claimId: string,
    relationshipType: string,
  ): Promise<ClaimRelationship[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('claim_id', claimId)
      .eq('relationship_type', relationshipType)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(
        `Failed to find claim relationships by type: ${error.message}`,
      );
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Create a relationship between two claims.
   */
  async create(
    familyId: string,
    claimId: string,
    relatedClaimId: string,
    relationshipType:
      | 'supports'
      | 'contradicts'
      | 'refines'
      | 'supersedes'
      | 'derived_from',
  ): Promise<ClaimRelationship> {
    const record: Omit<ClaimRelationship, 'createdAt'> = {
      familyId,
      claimId,
      relatedClaimId,
      relationshipType,
    };

    const { data, error } = await this.client
      .from(this.tableName)
      .insert(this.mapToDb(record))
      .select()
      .single();

    if (error) {
      // Ignore unique constraint violations (relationship already exists)
      if (error.code !== '23505') {
        throw new Error(
          `Failed to create claim relationship: ${error.message}`,
        );
      }
      // Return existing relationship
      const { data: existing, error: existingError } = await this.client
        .from(this.tableName)
        .select('*')
        .eq('family_id', familyId)
        .eq('claim_id', claimId)
        .eq('related_claim_id', relatedClaimId)
        .eq('relationship_type', relationshipType)
        .single();

      if (existingError) {
        throw new Error(
          `Failed to retrieve existing relationship: ${existingError.message}`,
        );
      }

      return this.mapFromDb(existing);
    }

    return this.mapFromDb(data);
  }

  /**
   * Delete a relationship between two claims.
   */
  async deleteRelationship(
    familyId: string,
    claimId: string,
    relatedClaimId: string,
    relationshipType: string,
  ): Promise<void> {
    const { error } = await this.client
      .from(this.tableName)
      .delete()
      .eq('family_id', familyId)
      .eq('claim_id', claimId)
      .eq('related_claim_id', relatedClaimId)
      .eq('relationship_type', relationshipType);

    if (error) {
      throw new Error(`Failed to delete claim relationship: ${error.message}`);
    }
  }

  /**
   * Find all contradicting claims for a claim.
   */
  async findContradicting(
    familyId: string,
    claimId: string,
  ): Promise<ClaimRelationship[]> {
    return this.findByType(familyId, claimId, 'contradicts');
  }

  /**
   * Find all supporting claims for a claim.
   */
  async findSupporting(
    familyId: string,
    claimId: string,
  ): Promise<ClaimRelationship[]> {
    return this.findByType(familyId, claimId, 'supports');
  }

  private mapFromDb(row: Record<string, unknown>): ClaimRelationship {
    return mapRowToCamelCase<ClaimRelationship>(row);
  }

  private mapToDb(record: Partial<ClaimRelationship>): Record<string, unknown> {
    return mapRecordToSnakeCase(record as unknown as Record<string, unknown>);
  }
}
