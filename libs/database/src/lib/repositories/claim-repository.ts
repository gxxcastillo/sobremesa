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
      .neq('status', 'redacted')
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
    // Query via claim_entities join table
    const { data, error } = await this.client
      .from('claim_entities')
      .select('claims!inner(*)')
      .eq('family_id', familyId)
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .neq('claims.status', 'redacted')
      .order('claimed_at', { foreignTable: 'claims', ascending: false });

    if (error) {
      throw new Error(`Failed to find claims by entity: ${error.message}`);
    }

    return (data || []).map((row: any) => this.mapFromDb(row.claims));
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
   * Note: Analysis fields (strength, inference method) are now in claim_analysis table.
   */
  async createFromExtracted(
    familyId: string,
    extracted: ExtractedClaim,
    conversationEventId: string,
    claimedBy: string,
    extractionVersion?: string,
  ): Promise<Claim> {
    // Parse claim_value from Scribe (may be JSON string or plain string)
    // Scribe outputs JSON strings for structured claims:
    //   '{"year": 1992, "month": 3, "day": 13, "text": "March 13, 1992"}'
    // Or plain strings for simple values: "great"
    let claimValue: Record<string, unknown>;
    if (typeof extracted.claimValue === 'string') {
      try {
        // Try to parse as JSON
        const parsed = JSON.parse(extracted.claimValue);
        claimValue =
          typeof parsed === 'object' && parsed !== null
            ? parsed
            : { value: extracted.claimValue };
      } catch {
        // Not JSON, wrap plain string in {value: ...}
        claimValue = { value: extracted.claimValue };
      }
    } else {
      // Already an object (shouldn't happen with new schema, but handle it)
      claimValue = extracted.claimValue as Record<string, unknown>;
    }

    const record: Omit<Claim, 'id' | 'createdAt' | 'updatedAt'> = {
      familyId,
      claimType: extracted.claimType,
      subject: extracted.subject,
      claimValue,
      conversationEventId,
      claimedBy,
      claimedBySource: extracted.claimedBySource,
      claimedAt: new Date(),
      confidence: extracted.confidence,
      certaintyLanguage: extracted.certaintyLanguage,
      contextOriginal: extracted.contextOriginal,
      // Note: Entity associations now via claim_entities join table

      status: 'active',
      extractionVersion,
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
