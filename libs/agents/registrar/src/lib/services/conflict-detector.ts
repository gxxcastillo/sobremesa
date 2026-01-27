import type { ExtractedClaim } from '@sobremesa/shared-types';
import { ClaimRepository } from '@sobremesa/database';
import {
  detectClaimConflict,
  subjectsMatch,
  canClaimTypeConflict,
} from '../conflict-detector.js';

/**
 * Result of conflict detection.
 */
export interface ConflictResult {
  hasConflict: boolean;
  conflictingClaimId?: string;
  conflictType?: 'contradicts' | 'refines' | 'supports';
  reasoning?: string;
}

/**
 * Result of conflict resolution.
 */
export interface ConflictResolutionResult {
  action: 'create_new' | 'supersede_existing' | 'mark_disputed';
  supersededClaimIds?: string[]; // Claims to mark as superseded
  reasoning: string;
}

/**
 * Service for detecting conflicts between claims.
 * Uses value-based conflict detection with optional semantic analysis via LLM.
 */
export class ConflictDetectorService {
  constructor(
    private claimRepo: ClaimRepository,
    // TODO: Add LLM client for semantic conflict detection
    // private llmClient?: AnthropicClient,
  ) {}

  /**
   * Detect conflicts for a new claim.
   *
   * @param familyId - Family ID
   * @param newClaim - The new claim to check
   * @returns Array of conflict results
   */
  async detectConflicts(
    familyId: string,
    newClaim: ExtractedClaim,
  ): Promise<ConflictResult[]> {
    // Only check for conflicts if the claim type can conflict
    if (!canClaimTypeConflict(newClaim.claimType)) {
      return [];
    }

    // Get existing active claims with similar subjects
    const existingClaims = await this.claimRepo.findActiveBySubject(
      familyId,
      newClaim.subject,
    );

    const conflicts: ConflictResult[] = [];

    for (const existing of existingClaims) {
      // Check if subjects match (same entity/topic)
      if (!subjectsMatch(existing.subject, newClaim.subject)) {
        continue;
      }

      // Check if claim types match
      if (existing.claimType !== newClaim.claimType) {
        continue;
      }

      // 1. Value-based conflict detection (fast, deterministic)
      const hasValueConflict = detectClaimConflict(
        existing.claimValue,
        newClaim.claimValue,
      );

      if (hasValueConflict) {
        conflicts.push({
          hasConflict: true,
          conflictingClaimId: existing.id,
          conflictType: 'contradicts',
          reasoning: 'Different values for same fact',
        });
        continue;
      }

      // 2. Check if new claim refines existing claim
      // (new claim has more detail but doesn't contradict)
      // Only check if newClaim.claimValue is an object
      if (
        typeof newClaim.claimValue === 'object' &&
        newClaim.claimValue !== null
      ) {
        const isRefinement = this.checkIfRefinement(
          existing.claimValue,
          newClaim.claimValue as Record<string, unknown>,
        );

        if (isRefinement) {
          conflicts.push({
            hasConflict: false,
            conflictingClaimId: existing.id,
            conflictType: 'refines',
            reasoning: 'New claim adds detail to existing claim',
          });
        }
      }

      // 3. TODO: Optional LLM for semantic conflict detection
      // if (this.llmClient && this.mightBeSemanticConflict(existing, newClaim)) {
      //   const llmResult = await this.checkSemanticConflict(existing, newClaim);
      //   if (llmResult.hasConflict) {
      //     conflicts.push(llmResult);
      //   }
      // }
    }

    return conflicts;
  }

  /**
   * Check if new claim refines (adds detail to) existing claim.
   */
  private checkIfRefinement(
    existingValue: Record<string, unknown>,
    newValue: Record<string, unknown>,
  ): boolean {
    // Refinement: new claim has all fields of existing claim plus more
    let hasAllExistingFields = true;
    let hasAdditionalFields = false;

    for (const key of Object.keys(existingValue)) {
      if (!(key in newValue)) {
        hasAllExistingFields = false;
        break;
      }

      // Check if values match (allowing for null/undefined in existing)
      const existingField = existingValue[key];
      const newField = newValue[key];

      if (
        existingField !== null &&
        existingField !== undefined &&
        existingField !== newField
      ) {
        hasAllExistingFields = false;
        break;
      }
    }

    // Check if new claim has additional fields
    for (const key of Object.keys(newValue)) {
      if (!(key in existingValue) || existingValue[key] === null) {
        hasAdditionalFields = true;
        break;
      }
    }

    return hasAllExistingFields && hasAdditionalFields;
  }

  /**
   * Resolve conflicts between new claim and existing claims.
   *
   * Resolution strategy:
   * 1. If new claim has much higher strength (>0.2 difference): supersede existing
   * 2. If strengths are close (<0.2 difference): mark both as disputed
   * 3. If existing claim has much higher strength: don't create new claim
   *
   * @param newClaimStrength - Strength of the new claim (0.0-1.0)
   * @param conflicts - Array of conflicting claims with their strengths
   * @returns Resolution decision
   */
  resolveConflicts(
    newClaimStrength: number,
    conflicts: Array<{ claimId: string; claimStrength?: number }>,
  ): ConflictResolutionResult {
    if (conflicts.length === 0) {
      return {
        action: 'create_new',
        reasoning: 'No conflicts detected',
      };
    }

    // Find highest strength among conflicting claims
    const maxExistingStrength = Math.max(
      ...conflicts.map((c) => c.claimStrength ?? 0.5),
    );

    const strengthDiff = newClaimStrength - maxExistingStrength;

    // Strategy 1: New claim is significantly stronger (>0.2 difference)
    if (strengthDiff > 0.2) {
      return {
        action: 'supersede_existing',
        supersededClaimIds: conflicts.map((c) => c.claimId),
        reasoning: `New claim strength (${newClaimStrength.toFixed(2)}) significantly higher than existing claims (max: ${maxExistingStrength.toFixed(2)})`,
      };
    }

    // Strategy 2: Existing claim is significantly stronger
    if (strengthDiff < -0.2) {
      // Don't create new claim - existing is more reliable
      return {
        action: 'mark_disputed',
        reasoning: `Existing claim strength (${maxExistingStrength.toFixed(2)}) significantly higher than new claim (${newClaimStrength.toFixed(2)}) - consider this claim disputed`,
      };
    }

    // Strategy 3: Strengths are close - mark both as disputed
    return {
      action: 'mark_disputed',
      reasoning: `Claim strengths are similar (new: ${newClaimStrength.toFixed(2)}, existing max: ${maxExistingStrength.toFixed(2)}) - requires manual review or LLM evaluation`,
    };
  }

  // TODO: Implement LLM-based semantic conflict detection
  // private mightBeSemanticConflict(
  //   existing: ClaimContext,
  //   newClaim: ExtractedClaim,
  // ): boolean {
  //   // Heuristics to decide if LLM evaluation is worth the cost
  //   // e.g., similar subjects but different claim types, ambiguous values, etc.
  //   return false;
  // }

  // private async checkSemanticConflict(
  //   existing: ClaimContext,
  //   newClaim: ExtractedClaim,
  // ): Promise<ConflictResult> {
  //   // Call LLM to determine if claims semantically conflict
  //   // Return ConflictResult with LLM reasoning
  //   return { hasConflict: false };
  // }
}
