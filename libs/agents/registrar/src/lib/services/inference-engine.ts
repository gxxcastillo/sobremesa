import type { ExtractedClaim, Claim } from '@sobremesa/shared-types';

/**
 * Inferred claim with metadata about the inference.
 */
export interface InferredClaim
  extends Omit<ExtractedClaim, 'claimedBy' | 'claimedBySource'> {
  claimedBy: string; // Inherited from source claim
  claimedBySource: 'attributed'; // Always attributed since it's inferred
  inferenceMethod: 'logical_inference';
  derivedFromClaimId: string; // ID of the source claim
  inferenceRule: string; // Which rule generated this inference
  inferenceConfidence: number; // 0.0-1.0
}

/**
 * Service for generating inferred claims from direct claims.
 *
 * Applies logical inference rules to create derived claims:
 * - Marriage → both people alive at marriage date
 * - Parent-child → age inference
 * - Death date → not alive after that date
 * - Birth date → alive after that date
 */
export class InferenceEngineService {
  /**
   * Generate inferences from a claim.
   *
   * @param claim - Source claim to generate inferences from
   * @param claimedBy - Person who made the original claim
   * @returns Array of inferred claims
   */
  generateInferences(claim: Claim, claimedBy: string): InferredClaim[] {
    const inferences: InferredClaim[] = [];

    // Marriage inferences
    if (
      claim.claimType === 'relationship' &&
      this.isMarriage(claim.claimValue)
    ) {
      inferences.push(...this.inferFromMarriage(claim, claimedBy));
    }

    // Parent-child inferences
    if (
      claim.claimType === 'relationship' &&
      this.isParentChild(claim.claimValue)
    ) {
      inferences.push(...this.inferFromParentChild(claim, claimedBy));
    }

    // Birth date inferences
    if (claim.claimType === 'date' && this.isBirthDate(claim.claimValue)) {
      inferences.push(...this.inferFromBirthDate(claim, claimedBy));
    }

    // Death date inferences
    if (claim.claimType === 'date' && this.isDeathDate(claim.claimValue)) {
      inferences.push(...this.inferFromDeathDate(claim, claimedBy));
    }

    return inferences;
  }

  /**
   * Infer from marriage claim:
   * - Both people were alive at marriage date
   */
  private inferFromMarriage(claim: Claim, claimedBy: string): InferredClaim[] {
    const inferences: InferredClaim[] = [];

    if (typeof claim.claimValue !== 'object' || claim.claimValue === null) {
      return inferences;
    }

    const marriageYear = claim.claimValue.year;
    if (typeof marriageYear !== 'number') {
      return inferences;
    }

    // We can't create "alive" inferences without knowing who the people are
    // This would require querying claim_entities to find the people involved
    // For now, we'll return empty array and implement this when we have entity context

    // TODO: Implement when we have access to PersonRepository to identify spouses
    // inferences.push({
    //   claimType: 'detail',
    //   subject: `${person1Name} alive status`,
    //   claimValue: { alive: true, year: marriageYear },
    //   ...
    // });

    return inferences;
  }

  /**
   * Infer from parent-child relationship:
   * - Parent was born 15-50 years before child
   * - If child has birth year, parent was likely alive at that time
   */
  private inferFromParentChild(
    claim: Claim,
    claimedBy: string,
  ): InferredClaim[] {
    const inferences: InferredClaim[] = [];

    // Similar to marriage - requires entity context to know who the people are
    // TODO: Implement with entity context

    return inferences;
  }

  /**
   * Infer from birth date:
   * - Person was alive after birth date (until death or current year)
   */
  private inferFromBirthDate(claim: Claim, claimedBy: string): InferredClaim[] {
    const inferences: InferredClaim[] = [];

    if (typeof claim.claimValue !== 'object' || claim.claimValue === null) {
      return inferences;
    }

    const birthYear = claim.claimValue.year;
    if (typeof birthYear !== 'number') {
      return inferences;
    }

    // TODO: Create "alive after birth" inference when we have entity context
    // This requires knowing the person's identity

    return inferences;
  }

  /**
   * Infer from death date:
   * - Person was not alive after death date
   * - Person's age at death (if birth year known)
   */
  private inferFromDeathDate(claim: Claim, claimedBy: string): InferredClaim[] {
    const inferences: InferredClaim[] = [];

    if (typeof claim.claimValue !== 'object' || claim.claimValue === null) {
      return inferences;
    }

    const deathYear = claim.claimValue.year;
    if (typeof deathYear !== 'number') {
      return inferences;
    }

    // TODO: Create "not alive after death" inference when we have entity context

    return inferences;
  }

  /**
   * Check if claim value represents a marriage.
   */
  private isMarriage(claimValue: Record<string, unknown>): boolean {
    if (typeof claimValue !== 'object' || claimValue === null) {
      return false;
    }
    const relType = claimValue.type || claimValue.relationshipType;
    return relType === 'spouse' || relType === 'marriage';
  }

  /**
   * Check if claim value represents a parent-child relationship.
   */
  private isParentChild(claimValue: Record<string, unknown>): boolean {
    if (typeof claimValue !== 'object' || claimValue === null) {
      return false;
    }
    const relType = claimValue.type || claimValue.relationshipType;
    return relType === 'parent' || relType === 'child';
  }

  /**
   * Check if claim value represents a birth date.
   */
  private isBirthDate(claimValue: Record<string, unknown>): boolean {
    if (typeof claimValue !== 'object' || claimValue === null) {
      return false;
    }
    const eventType = claimValue.eventType || claimValue.type;
    return eventType === 'birth';
  }

  /**
   * Check if claim value represents a death date.
   */
  private isDeathDate(claimValue: Record<string, unknown>): boolean {
    if (typeof claimValue !== 'object' || claimValue === null) {
      return false;
    }
    const eventType = claimValue.eventType || claimValue.type;
    return eventType === 'death';
  }

  /**
   * Calculate confidence for an inference.
   * Inferred claims typically have lower confidence than direct claims.
   *
   * @param ruleType - Type of inference rule applied
   * @param sourceClaimStrength - Strength of the source claim
   * @returns Confidence score 0.0-1.0
   */
  calculateInferenceConfidence(
    ruleType: string,
    sourceClaimStrength: number,
  ): number {
    // Base confidence by rule type
    const baseConfidence: Record<string, number> = {
      marriage_alive: 0.9, // If married, very likely both alive
      birth_alive: 0.95, // If born, definitely alive at birth
      death_not_alive: 0.95, // If death recorded, definitely not alive after
      parent_age: 0.7, // Age difference inference is less certain
    };

    const base = baseConfidence[ruleType] || 0.7;

    // Reduce by source claim strength
    // If source claim is weak, inference is even weaker
    return base * sourceClaimStrength;
  }
}
