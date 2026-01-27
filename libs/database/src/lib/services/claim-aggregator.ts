import type { Claim } from '@sobremesa/shared-types';
import { Confidence } from '@sobremesa/shared-types';
import { ClaimEntityRepository } from '../repositories/claim-entity-repository.js';

/**
 * Result of aggregating claims for a specific field.
 */
export interface FieldAggregationResult {
  value: unknown;
  confidence: Confidence;
  supportingClaimIds: string[]; // IDs of claims used in aggregation
  reasoning: string; // Explanation of how value was determined
}

/**
 * Aggregated entity data from claims.
 */
export interface AggregatedPersonData {
  birthYear?: FieldAggregationResult;
  deathYear?: FieldAggregationResult;
  // Add more fields as needed
}

/**
 * Service for aggregating claims into entity-level fields.
 *
 * Converts multiple claims about an entity into materialized entity fields
 * with confidence scores. Uses consensus detection, weighted averaging,
 * and conflict resolution.
 */
export class ClaimAggregatorService {
  constructor(private claimEntityRepo: ClaimEntityRepository) {}

  /**
   * Aggregate all active claims for a person into entity fields.
   *
   * @param familyId - Family ID
   * @param personId - Person entity ID
   * @returns Aggregated person data with confidence scores
   */
  async aggregatePersonData(
    familyId: string,
    personId: string,
  ): Promise<AggregatedPersonData> {
    // Get all claims about this person (including merged predecessors)
    const claims =
      await this.claimEntityRepo.findClaimsForEntityIncludingMerged(
        familyId,
        personId,
        'person',
      );

    // Filter to active claims only
    const activeClaims = claims.filter((c) => c.status === 'active');

    const result: AggregatedPersonData = {};

    // Aggregate birth year
    const birthYearClaims = this.filterClaimsByType(
      activeClaims,
      'date',
      (claimValue) => {
        if (typeof claimValue !== 'object' || claimValue === null) {
          return false;
        }
        const eventType = claimValue.eventType || claimValue.type;
        return eventType === 'birth';
      },
    );

    if (birthYearClaims.length > 0) {
      result.birthYear = this.aggregateYearField(birthYearClaims, 'year');
    }

    // Aggregate death year
    const deathYearClaims = this.filterClaimsByType(
      activeClaims,
      'date',
      (claimValue) => {
        if (typeof claimValue !== 'object' || claimValue === null) {
          return false;
        }
        const eventType = claimValue.eventType || claimValue.type;
        return eventType === 'death';
      },
    );

    if (deathYearClaims.length > 0) {
      result.deathYear = this.aggregateYearField(deathYearClaims, 'year');
    }

    return result;
  }

  /**
   * Filter claims by type and additional predicate.
   */
  private filterClaimsByType(
    claims: Claim[],
    claimType: string,
    predicate?: (claimValue: Record<string, unknown>) => boolean,
  ): Claim[] {
    return claims.filter((claim) => {
      if (claim.claimType !== claimType) {
        return false;
      }
      if (
        predicate &&
        typeof claim.claimValue === 'object' &&
        claim.claimValue !== null
      ) {
        return predicate(claim.claimValue);
      }
      return !predicate;
    });
  }

  /**
   * Aggregate year values from multiple claims.
   *
   * Strategy:
   * 1. Group claims by value
   * 2. Calculate weighted score per value (sum of claim strengths)
   * 3. If one value has >70% of total weight, use it (consensus)
   * 4. If values are close (within 2 years), use weighted average
   * 5. Otherwise, use highest-strength claim (conflicting data)
   */
  private aggregateYearField(
    claims: Claim[],
    fieldName: string,
  ): FieldAggregationResult {
    // Extract year values and strengths
    type ValueGroup = {
      value: number;
      claims: Claim[];
      totalStrength: number;
    };

    const valueGroups = new Map<number, ValueGroup>();

    for (const claim of claims) {
      if (typeof claim.claimValue !== 'object' || claim.claimValue === null) {
        continue;
      }

      const year = claim.claimValue[fieldName];
      if (typeof year !== 'number') {
        continue;
      }

      const strength = claim.claimStrength ?? 0.5; // Default to 0.5 if not calculated

      if (!valueGroups.has(year)) {
        valueGroups.set(year, {
          value: year,
          claims: [],
          totalStrength: 0,
        });
      }

      const group = valueGroups.get(year)!;
      group.claims.push(claim);
      group.totalStrength += strength;
    }

    if (valueGroups.size === 0) {
      throw new Error('No valid year values found in claims');
    }

    // Calculate total weight across all groups
    let totalWeight = 0;
    for (const group of valueGroups.values()) {
      totalWeight += group.totalStrength;
    }

    // Sort groups by total strength (descending)
    const sortedGroups = Array.from(valueGroups.values()).sort(
      (a, b) => b.totalStrength - a.totalStrength,
    );

    const topGroup = sortedGroups[0];

    // Strategy 1: Consensus (one value has >70% of weight)
    if (topGroup.totalStrength / totalWeight > 0.7) {
      return {
        value: topGroup.value,
        confidence: Confidence.HIGH,
        supportingClaimIds: topGroup.claims.map((c) => c.id),
        reasoning: `Consensus: ${topGroup.claims.length} claim(s) agree on ${topGroup.value} (${Math.round((topGroup.totalStrength / totalWeight) * 100)}% confidence)`,
      };
    }

    // Strategy 2: Close values (within 2 years) - use weighted average
    if (valueGroups.size === 2) {
      const [group1, group2] = sortedGroups;
      const diff = Math.abs(group1.value - group2.value);

      if (diff <= 2) {
        // Weighted average
        const weightedSum =
          group1.value * group1.totalStrength +
          group2.value * group2.totalStrength;
        const weightedAvg = Math.round(weightedSum / totalWeight);

        const allClaims = [...group1.claims, ...group2.claims];

        return {
          value: weightedAvg,
          confidence: Confidence.MEDIUM,
          supportingClaimIds: allClaims.map((c) => c.id),
          reasoning: `Weighted average of close values: ${group1.value} (${group1.claims.length} claim(s)) and ${group2.value} (${group2.claims.length} claim(s))`,
        };
      }
    }

    // Strategy 3: Conflicting data - use highest-strength claim
    const confidence =
      topGroup.totalStrength / totalWeight > 0.5
        ? Confidence.MEDIUM
        : Confidence.LOW;

    return {
      value: topGroup.value,
      confidence,
      supportingClaimIds: topGroup.claims.map((c) => c.id),
      reasoning: `Conflicting data: using highest-strength claim(s) for ${topGroup.value} (${topGroup.claims.length} claim(s) vs ${valueGroups.size - 1} other value(s))`,
    };
  }

  /**
   * Aggregate string field with exact matching.
   *
   * Strategy:
   * 1. Group by exact value
   * 2. Return value with highest total claim strength
   * 3. Confidence based on agreement level
   */
  aggregateStringField(
    claims: Claim[],
    fieldName: string,
  ): FieldAggregationResult | null {
    type ValueGroup = {
      value: string;
      claims: Claim[];
      totalStrength: number;
    };

    const valueGroups = new Map<string, ValueGroup>();

    for (const claim of claims) {
      if (typeof claim.claimValue !== 'object' || claim.claimValue === null) {
        continue;
      }

      const value = claim.claimValue[fieldName];
      if (typeof value !== 'string') {
        continue;
      }

      const strength = claim.claimStrength ?? 0.5;

      if (!valueGroups.has(value)) {
        valueGroups.set(value, {
          value,
          claims: [],
          totalStrength: 0,
        });
      }

      const group = valueGroups.get(value)!;
      group.claims.push(claim);
      group.totalStrength += strength;
    }

    if (valueGroups.size === 0) {
      return null;
    }

    // Sort by total strength
    const sortedGroups = Array.from(valueGroups.values()).sort(
      (a, b) => b.totalStrength - a.totalStrength,
    );

    const topGroup = sortedGroups[0];

    // Calculate total weight
    const totalWeight = sortedGroups.reduce(
      (sum, g) => sum + g.totalStrength,
      0,
    );

    // Determine confidence
    let confidence: Confidence;
    const weightRatio = topGroup.totalStrength / totalWeight;

    if (weightRatio > 0.8) {
      confidence = Confidence.HIGH;
    } else if (weightRatio > 0.6) {
      confidence = Confidence.MEDIUM;
    } else {
      confidence = Confidence.LOW;
    }

    return {
      value: topGroup.value,
      confidence,
      supportingClaimIds: topGroup.claims.map((c) => c.id),
      reasoning:
        valueGroups.size === 1
          ? `All ${topGroup.claims.length} claim(s) agree`
          : `Strongest evidence for "${topGroup.value}" (${topGroup.claims.length} claim(s) vs ${valueGroups.size - 1} other value(s))`,
    };
  }
}
