import { SupabaseClient } from '@supabase/supabase-js';
import type { Claim, ExtractedClaim } from '@sobremesa/shared-types';
import {
  BaseRepository,
  mapRowToCamelCase,
  mapRecordToSnakeCase,
} from '../base-repository.js';

/**
 * Repository for atomic factual claims with provenance.
 */
export class ClaimRepository extends BaseRepository<Claim> {
  constructor(client?: SupabaseClient) {
    super('claims', client);
  }

  /**
   * Find claims by subject.
   */
  async findBySubject(familyId: string, subject: string): Promise<Claim[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('redacted', false)
      .ilike('subject', `%${subject}%`)
      .order('claimed_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find claims by subject: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find active claims by subject (for conflict detection).
   */
  async findActiveBySubject(
    familyId: string,
    subject: string,
  ): Promise<Claim[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('redacted', false)
      .eq('status', 'active')
      .ilike('subject', `%${subject}%`)
      .order('claimed_at', { ascending: false });

    if (error) {
      throw new Error(
        `Failed to find active claims by subject: ${error.message}`,
      );
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find claims by entity.
   */
  async findByEntity(
    familyId: string,
    entityType: string,
    entityId: string,
  ): Promise<Claim[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('redacted', false)
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .order('claimed_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find claims by entity: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find conflicting claims for a given claim.
   */
  async findConflicting(familyId: string, claimId: string): Promise<Claim[]> {
    // First get the conflict IDs from claim_conflicts table
    const { data: conflicts, error: conflictError } = await this.client
      .from('claim_conflicts')
      .select('conflicts_with_claim_id')
      .eq('family_id', familyId)
      .eq('claim_id', claimId);

    if (conflictError) {
      throw new Error(
        `Failed to find claim conflicts: ${conflictError.message}`,
      );
    }

    if (!conflicts || conflicts.length === 0) {
      return [];
    }

    // Get the actual claims
    const conflictIds = conflicts.map((c) => c.conflicts_with_claim_id);
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .in('id', conflictIds);

    if (error) {
      throw new Error(`Failed to find conflicting claims: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Create a claim from extracted data.
   */
  async createFromExtracted(
    familyId: string,
    extracted: ExtractedClaim,
    sourceEventId: string,
    claimedBy: string,
    entityId?: string,
    entityType?: 'person' | 'place' | 'event' | 'story',
  ): Promise<Claim> {
    const record: Omit<Claim, 'id' | 'createdAt' | 'updatedAt'> = {
      familyId,
      claimType: extracted.claimType,
      subject: extracted.subject,
      claimValue: extracted.claimValue,
      sourceEventId,
      claimedBy,
      claimedBySource: extracted.claimedBySource,
      claimedAt: new Date(),
      confidence: extracted.confidence,
      certaintyLanguage: extracted.certaintyLanguage,
      contextOriginal: extracted.contextOriginal,
      entityId,
      entityType,
      status: 'active',
      redacted: false,
    };

    return await this.insert(record);
  }

  /**
   * Add a conflict link between two claims (bidirectional).
   */
  async addConflict(
    familyId: string,
    claimId: string,
    conflictsWithClaimId: string,
  ): Promise<void> {
    // Insert both directions
    const { error } = await this.client.from('claim_conflicts').insert([
      {
        family_id: familyId,
        claim_id: claimId,
        conflicts_with_claim_id: conflictsWithClaimId,
      },
      {
        family_id: familyId,
        claim_id: conflictsWithClaimId,
        conflicts_with_claim_id: claimId,
      },
    ]);

    if (error) {
      // Ignore unique constraint violations (conflict already exists)
      if (error.code !== '23505') {
        throw new Error(`Failed to add claim conflict: ${error.message}`);
      }
    }
  }

  /**
   * Mark a claim as superseded.
   */
  async markSuperseded(familyId: string, claimId: string): Promise<Claim> {
    const { data, error } = await this.client
      .from(this.tableName)
      .update({ status: 'superseded' })
      .eq('family_id', familyId)
      .eq('id', claimId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to mark claim as superseded: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Mark a claim as disputed.
   */
  async markDisputed(familyId: string, claimId: string): Promise<Claim> {
    const { data, error } = await this.client
      .from(this.tableName)
      .update({ status: 'disputed' })
      .eq('family_id', familyId)
      .eq('id', claimId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to mark claim as disputed: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Find all active claims for a family.
   */
  async findAllActive(familyId: string): Promise<Claim[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('redacted', false)
      .eq('status', 'active')
      .order('claimed_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find claims: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Detect if two claim values are conflicting.
   */
  detectConflict(
    existingValue: Record<string, unknown>,
    newValue: Record<string, unknown>,
  ): boolean {
    // Compare key fields for contradiction
    for (const key of Object.keys(newValue)) {
      if (key in existingValue) {
        const existing = existingValue[key];
        const newVal = newValue[key];

        // If both have values and they're different, it's a conflict
        if (
          existing !== undefined &&
          existing !== null &&
          newVal !== undefined &&
          newVal !== null &&
          existing !== newVal
        ) {
          // Special handling for numbers (allow for approximate matches)
          if (typeof existing === 'number' && typeof newVal === 'number') {
            // Consider a conflict if difference is more than 2 years
            if (Math.abs(existing - newVal) > 2) {
              return true;
            }
          } else {
            return true;
          }
        }
      }
    }

    return false;
  }

  protected mapFromDb(row: Record<string, unknown>): Claim {
    return mapRowToCamelCase<Claim>(row);
  }

  protected mapToDb(record: Claim): Record<string, unknown> {
    return mapRecordToSnakeCase(record as unknown as Record<string, unknown>);
  }
}
