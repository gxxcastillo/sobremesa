import type { ExtractedClaim, ClaimSourceType } from '@sobremesa/shared-types';

/**
 * Strength calculation result.
 */
export interface StrengthResult {
  score: number; // 0.0-1.0
  factors: StrengthFactors;
  needsLlmEvaluation: boolean;
}

/**
 * Detailed breakdown of strength calculation.
 */
export interface StrengthFactors {
  algorithmScore: number;
  breakdown: Record<string, number>; // Detailed factor breakdown
  final: number;
  llmScore?: number;
  llmReasoning?: string;
  evaluationTriggered?: string[]; // Reasons for LLM evaluation
  /**
   * Set to 'failed' when the claim's evidence span matched neither the current
   * message nor context (paraphrase or hallucination — see grounding.ts).
   * Definite context bleed is rejected outright and never reaches analysis.
   */
  grounding?: 'failed';
}

/**
 * Service for calculating claim strength using hybrid algorithmic approach.
 *
 * Phase 1: Algorithmic scoring (all claims, $0 cost)
 * Phase 2: Flag for LLM evaluation (5-10% of claims)
 * Phase 3: LLM evaluation happens async via background worker
 */
export class StrengthCalculatorService {
  /**
   * Calculate claim strength from extracted claim data.
   *
   * @param claim - Extracted claim from Scribe
   * @param conflictCount - Number of conflicting claims detected
   * @param isHighStakes - Whether this is a critical claim (birth/death dates, legal relationships)
   * @returns Strength result with score, factors, and LLM evaluation flag
   */
  calculate(
    claim: ExtractedClaim,
    conflictCount = 0,
    isHighStakes = false,
  ): StrengthResult {
    // Base score from source type
    const sourceTypeScore = this.getSourceTypeScore(claim.claimedBySource);

    // Certainty modifier from language analysis
    const certaintyModifier = this.getCertaintyModifier(
      claim.certaintyLanguage,
    );

    // Conflict penalty (multiplicative)
    const conflictPenalty = this.getConflictPenalty(conflictCount);

    // Calculate final algorithmic score
    const algorithmScore = Math.max(
      0.0,
      Math.min(1.0, sourceTypeScore * certaintyModifier * conflictPenalty),
    );

    // Determine if LLM evaluation is needed
    const evaluationTriggers: string[] = [];
    if (conflictCount > 0) {
      evaluationTriggers.push('hasConflicts');
    }
    if (this.hasUncertaintyLanguage(claim.certaintyLanguage)) {
      evaluationTriggers.push('uncertaintyLanguage');
    }
    if (claim.claimedBySource === 'hearsay') {
      evaluationTriggers.push('hearsaySource');
    }
    if (isHighStakes) {
      evaluationTriggers.push('highStakes');
    }
    if (algorithmScore < 0.6) {
      evaluationTriggers.push('lowInitialScore');
    }

    const needsLlmEvaluation = evaluationTriggers.length > 0;

    return {
      score: algorithmScore,
      factors: {
        algorithmScore,
        breakdown: {
          sourceTypeScore,
          certaintyModifier,
          conflictPenalty,
        },
        final: algorithmScore,
        evaluationTriggered: needsLlmEvaluation
          ? evaluationTriggers
          : undefined,
      },
      needsLlmEvaluation,
    };
  }

  /**
   * Get base score from source type.
   */
  private getSourceTypeScore(sourceType: ClaimSourceType): number {
    switch (sourceType) {
      case 'direct':
        return 1.0; // Speaker is claiming about themselves
      case 'attributed':
        return 0.8; // Speaker is quoting someone else
      case 'hearsay':
        return 0.5; // Vague attribution ("they say", "I heard")
      default:
        return 0.7; // Unknown source type
    }
  }

  /**
   * Get certainty modifier from language analysis.
   */
  private getCertaintyModifier(certaintyLanguage?: string): number {
    if (!certaintyLanguage) {
      return 1.0; // No certainty language = neutral
    }

    const lower = certaintyLanguage.toLowerCase();

    // High certainty
    if (
      lower.includes('definitely') ||
      lower.includes('certainly') ||
      lower.includes('positive') ||
      lower.includes('absolutely') ||
      lower.includes('sure')
    ) {
      return 1.0;
    }

    // Medium-high certainty
    if (
      lower.includes('probably') ||
      lower.includes('likely') ||
      lower.includes('believe')
    ) {
      return 0.9;
    }

    // Medium certainty
    if (
      lower.includes('think') ||
      lower.includes('maybe') ||
      lower.includes('perhaps')
    ) {
      return 0.7;
    }

    // Low certainty
    if (
      lower.includes('might') ||
      lower.includes('could') ||
      lower.includes('possibly') ||
      lower.includes('not sure') ||
      lower.includes('uncertain')
    ) {
      return 0.6;
    }

    // Pure clarification (no factual assertion)
    if (lower === 'questioning' || lower === 'question' || lower === 'asking') {
      return 0.3;
    }

    return 1.0; // Default to neutral if no matches
  }

  /**
   * Get conflict penalty (multiplicative).
   */
  private getConflictPenalty(conflictCount: number): number {
    if (conflictCount === 0) {
      return 1.0; // No penalty
    }

    // Each conflict reduces strength by 20% (multiplicative)
    // 1 conflict: 0.8
    // 2 conflicts: 0.64
    // 3 conflicts: 0.512
    return Math.pow(0.8, conflictCount);
  }

  /**
   * Check if certainty language indicates uncertainty.
   */
  private hasUncertaintyLanguage(certaintyLanguage?: string): boolean {
    if (!certaintyLanguage) {
      return false;
    }

    const lower = certaintyLanguage.toLowerCase();
    return (
      lower.includes('think') ||
      lower.includes('maybe') ||
      lower.includes('probably') ||
      lower.includes('might') ||
      lower.includes('could') ||
      lower.includes('possibly') ||
      lower.includes('not sure') ||
      lower.includes('uncertain')
    );
  }

  /**
   * Blend algorithmic and LLM scores (called after LLM evaluation completes).
   *
   * @param algorithmScore - Initial algorithmic score (0.0-1.0)
   * @param llmScore - LLM evaluation score (0.0-1.0)
   * @returns Blended final score (0.0-1.0)
   */
  blendScores(algorithmScore: number, llmScore: number): number {
    // Weight: 40% algorithm, 60% LLM
    return algorithmScore * 0.4 + llmScore * 0.6;
  }

  /**
   * Determine if a claim type is high stakes (birth/death dates, legal relationships).
   */
  isHighStakesClaim(
    claimType: string,
    claimValue: string | Record<string, unknown>,
  ): boolean {
    // Birth/death dates are high stakes
    if (claimType === 'date') {
      if (typeof claimValue === 'object' && claimValue !== null) {
        const eventType =
          (claimValue as Record<string, unknown>).eventType ||
          (claimValue as Record<string, unknown>).type;
        if (eventType === 'birth' || eventType === 'death') {
          return true;
        }
      }
    }

    // Legal relationships (marriage, adoption) are high stakes
    if (claimType === 'relationship') {
      if (typeof claimValue === 'object' && claimValue !== null) {
        const relType = (claimValue as Record<string, unknown>).type;
        if (
          relType === 'spouse' ||
          relType === 'parent' ||
          relType === 'adopted'
        ) {
          return true;
        }
      }
    }

    return false;
  }
}
