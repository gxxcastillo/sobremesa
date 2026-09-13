import type { DatabaseClient } from '../client';
import type { ClaimRelationship } from '@sobremesa/shared-types';
import { mapRowToCamelCase, mapRecordToSnakeCase } from '../base-repository.js';

/**
 * Repository for claim-to-claim relationships (supports, contradicts, refines, etc.).
 * Note: Does not extend BaseRepository since this is a join table with composite key.
 */
export class ClaimRelationshipRepository {
  protected client: DatabaseClient;
  protected tableName = 'claim_relationships';

  constructor(client: DatabaseClient) {
    this.client = client;
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
   * Find the ids of claims that contradict a given claim, in either
   * direction. `create()` only ever writes one directed edge per
   * contradiction (the newer claim -> the older claim it disputes), so the
   * older claim can be contradicted without ever being a row's `claim_id`.
   */
  async findContradictingClaimIds(
    familyId: string,
    claimId: string,
  ): Promise<string[]> {
    const partnerIdsByClaimId = await this.findContradictingClaimIdsForClaims(
      familyId,
      [claimId],
    );
    return partnerIdsByClaimId.get(claimId) ?? [];
  }

  /**
   * Batched form of `findContradictingClaimIds` for a whole set of claim
   * ids -- two queries total (one per direction) instead of two per claim.
   * Returns a map from claim id to its contradicting partner ids; a claim
   * with no contradictions is absent from the map.
   */
  async findContradictingClaimIdsForClaims(
    familyId: string,
    claimIds: string[],
  ): Promise<Map<string, string[]>> {
    const partnerIdsByClaimId = new Map<string, string[]>();
    if (claimIds.length === 0) {
      return partnerIdsByClaimId;
    }

    const addPartner = (claimId: string, partnerId: string) => {
      const partners = partnerIdsByClaimId.get(claimId);
      if (partners) {
        if (!partners.includes(partnerId)) {
          partners.push(partnerId);
        }
      } else {
        partnerIdsByClaimId.set(claimId, [partnerId]);
      }
    };

    const [outgoing, incoming] = await Promise.all([
      this.client
        .from(this.tableName)
        .select('*')
        .eq('family_id', familyId)
        .eq('relationship_type', 'contradicts')
        .in('claim_id', claimIds),
      this.client
        .from(this.tableName)
        .select('*')
        .eq('family_id', familyId)
        .eq('relationship_type', 'contradicts')
        .in('related_claim_id', claimIds),
    ]);

    if (outgoing.error) {
      throw new Error(
        `Failed to find claim relationships: ${outgoing.error.message}`,
      );
    }
    if (incoming.error) {
      throw new Error(
        `Failed to find related claims: ${incoming.error.message}`,
      );
    }

    for (const row of outgoing.data || []) {
      const rel = this.mapFromDb(row);
      addPartner(rel.claimId, rel.relatedClaimId);
    }
    for (const row of incoming.data || []) {
      const rel = this.mapFromDb(row);
      addPartner(rel.relatedClaimId, rel.claimId);
    }

    return partnerIdsByClaimId;
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
