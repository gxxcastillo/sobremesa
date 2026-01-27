import { SupabaseClient } from '@supabase/supabase-js';
import type { ClaimAnalysis } from '@sobremesa/shared-types';
import {
  BaseRepository,
  mapRowToCamelCase,
  mapRecordToSnakeCase,
} from '../base-repository.js';

/**
 * Repository for claim analysis (system-computed metadata).
 * Separated from immutable claim provenance.
 */
export class ClaimAnalysisRepository extends BaseRepository<ClaimAnalysis> {
  constructor(client?: SupabaseClient) {
    super('claim_analysis', client);
  }

  /**
   * Create analysis record for a claim.
   */
  async createForClaim(
    familyId: string,
    claimId: string,
    analysis: {
      inferenceMethod?: 'direct' | 'logical_inference' | 'llm_inference';
      claimStrength?: number;
      strengthFactors?: {
        algorithmScore: number;
        breakdown: Record<string, number>;
        llmScore?: number;
        llmReasoning?: string;
        final: number;
        evaluationTriggered?: string[];
      };
      needsLlmEvaluation?: boolean;
    },
  ): Promise<ClaimAnalysis> {
    const record: Omit<ClaimAnalysis, 'id' | 'createdAt' | 'updatedAt'> = {
      familyId,
      claimId,
      inferenceMethod: analysis.inferenceMethod,
      claimStrength: analysis.claimStrength,
      strengthFactors: analysis.strengthFactors,
      needsLlmEvaluation: analysis.needsLlmEvaluation ?? false,
    };

    return await this.insert(record);
  }

  /**
   * Find analysis for a claim.
   */
  async findByClaimId(
    familyId: string,
    claimId: string,
  ): Promise<ClaimAnalysis | null> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('claim_id', claimId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // Not found
        return null;
      }
      throw new Error(`Failed to find claim analysis: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Update analysis with LLM evaluation results.
   * Called by LLM evaluation worker after processing queue item.
   */
  async updateLlmEvaluation(
    familyId: string,
    claimId: string,
    result: {
      llmScore: number;
      llmReasoning: string;
      finalStrength: number;
      strengthFactors: {
        algorithmScore: number;
        breakdown: Record<string, number>;
        llmScore: number;
        llmReasoning: string;
        final: number;
        evaluationTriggered?: string[];
      };
    },
  ): Promise<ClaimAnalysis> {
    const { data, error } = await this.client
      .from(this.tableName)
      .update({
        claim_strength: result.finalStrength,
        strength_factors: result.strengthFactors,
        updated_at: new Date().toISOString(),
      })
      .eq('family_id', familyId)
      .eq('claim_id', claimId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update LLM evaluation: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Find all claims needing LLM evaluation.
   */
  async findNeedingLlmEvaluation(
    familyId: string,
    limit = 100,
  ): Promise<ClaimAnalysis[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('needs_llm_evaluation', true)
      .order('created_at', { ascending: true })
      .limit(limit);

    if (error) {
      throw new Error(
        `Failed to find claims needing evaluation: ${error.message}`,
      );
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Batch find analysis for multiple claims.
   */
  async findByClaimIds(
    familyId: string,
    claimIds: string[],
  ): Promise<ClaimAnalysis[]> {
    if (claimIds.length === 0) {
      return [];
    }

    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .in('claim_id', claimIds);

    if (error) {
      throw new Error(`Failed to find claim analyses: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  protected mapFromDb(row: Record<string, unknown>): ClaimAnalysis {
    return mapRowToCamelCase<ClaimAnalysis>(row);
  }

  protected mapToDb(record: ClaimAnalysis): Record<string, unknown> {
    return mapRecordToSnakeCase(record as unknown as Record<string, unknown>);
  }
}
