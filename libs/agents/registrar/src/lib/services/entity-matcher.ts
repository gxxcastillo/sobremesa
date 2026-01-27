import type { ExtractedPerson, ExtractedPlace } from '@sobremesa/shared-types';
import { PersonRepository, PlaceRepository } from '@sobremesa/database';
import { createLogger } from '@sobremesa/shared-utils';

/**
 * Result of entity matching.
 */
export interface MatchResult {
  matched: boolean;
  existingEntityId?: string;
  confidence: number; // 0.0-1.0
  matchReason: string;
  suggestedAliases?: string[]; // New aliases to add to existing entity
}

/**
 * Service for entity matching logic.
 * Determines if an extracted entity matches an existing entity in the database.
 */
export class EntityMatcherService {
  private logger = createLogger({ name: 'entity-matcher' });

  constructor(
    private personRepo: PersonRepository,
    private placeRepo: PlaceRepository,
    // TODO: Add LLM client for uncertain matches
    // private llmClient?: AnthropicClient,
  ) {}

  /**
   * Match a person against existing people in the database.
   *
   * @param familyId - Family ID
   * @param extracted - Extracted person from Scribe
   * @returns Match result with confidence and reasoning
   */
  async matchPerson(
    familyId: string,
    extracted: ExtractedPerson,
  ): Promise<MatchResult> {
    // Use repository's existing matching logic
    const result = await this.personRepo.findBestMatch(
      familyId,
      extracted.name,
      extracted.aliases || [],
    );

    if (!result) {
      return {
        matched: false,
        confidence: 0,
        matchReason: 'no_match',
      };
    }

    // Check for biographical conflicts before accepting the match
    const hasConflict = this.hasBiographicalConflict(extracted, result.person);
    if (hasConflict) {
      this.logger.info(
        {
          extractedName: extracted.name,
          extractedBirthYear: extracted.birthYear,
          extractedDeathYear: extracted.deathYear,
          candidateName: result.person.name,
          candidateBirthYear: result.person.birthYear,
          candidateDeathYear: result.person.deathYear,
          originalMatchReason: result.matchReason,
        },
        'Biographical conflict detected - will create separate entity instead of merging',
      );
      return {
        matched: false,
        confidence: 0,
        matchReason: 'biographical_conflict_creating_new',
      };
    }

    // Convert repository confidence to numeric score
    const confidenceScore = this.convertConfidence(result.confidence);

    // Determine if we should suggest adding the searched name as an alias
    const suggestedAliases = this.getSuggestedAliases(
      extracted,
      result.person.name,
      result.person.aliases || [],
    );

    return {
      matched: true,
      existingEntityId: result.person.id,
      confidence: confidenceScore,
      matchReason: result.matchReason,
      suggestedAliases,
    };

    // TODO: For uncertain matches (0.7-0.9), optionally verify with LLM
    // if (confidenceScore >= 0.7 && confidenceScore < 0.9 && this.llmClient) {
    //   const llmVerified = await this.verifyMatchWithLlm(extracted, result.person);
    //   if (llmVerified) {
    //     return {
    //       matched: true,
    //       existingEntityId: result.person.id,
    //       confidence: 0.85,
    //       matchReason: 'contextual (LLM verified)',
    //       suggestedAliases,
    //     };
    //   }
    // }
  }

  /**
   * Match a place against existing places in the database.
   *
   * @param familyId - Family ID
   * @param extracted - Extracted place from Scribe
   * @returns Match result with confidence and reasoning
   */
  async matchPlace(
    familyId: string,
    extracted: ExtractedPlace,
  ): Promise<MatchResult> {
    // Try exact name match first
    const exactMatch = await this.placeRepo.findByName(
      familyId,
      extracted.name,
    );

    if (exactMatch) {
      return {
        matched: true,
        existingEntityId: exactMatch.id,
        confidence: 1.0,
        matchReason: 'exact_name',
      };
    }

    // Get all places and try fuzzy matching
    const allPlaces = await this.placeRepo.findAllActive(familyId);

    let bestMatch = null;
    let bestSimilarity = 0;

    for (const place of allPlaces) {
      const similarity = this.stringSimilarity(extracted.name, place.name);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = place;
      }
    }

    if (bestMatch && bestSimilarity >= 0.8) {
      const confidence = this.calculatePlaceMatchConfidence(
        extracted,
        bestMatch,
      );

      if (confidence >= 0.8) {
        return {
          matched: true,
          existingEntityId: bestMatch.id,
          confidence,
          matchReason: 'fuzzy_match',
        };
      }
    }

    // If city/country provided, try hierarchical match
    if (extracted.city || extracted.country) {
      const hierarchicalMatch = await this.findPlaceByHierarchy(
        familyId,
        extracted,
      );

      if (hierarchicalMatch) {
        return {
          matched: true,
          existingEntityId: hierarchicalMatch.id,
          confidence: 0.9,
          matchReason: 'hierarchical_match',
        };
      }
    }

    // No match found
    return {
      matched: false,
      confidence: 0,
      matchReason: 'no_match',
    };
  }

  /**
   * Check if extracted person has biographical conflicts with existing person.
   * Returns true if birth years or death years conflict significantly.
   */
  private hasBiographicalConflict(
    extracted: ExtractedPerson,
    existing: any,
  ): boolean {
    const YEAR_TOLERANCE = 5; // Allow up to 5 years difference (accounts for uncertainty)

    // Check birth year conflict
    if (extracted.birthYear && existing.birthYear) {
      const yearDiff = Math.abs(extracted.birthYear - existing.birthYear);
      if (yearDiff > YEAR_TOLERANCE) {
        return true; // Birth years conflict
      }
    }

    // Check death year conflict
    if (extracted.deathYear && existing.deathYear) {
      const yearDiff = Math.abs(extracted.deathYear - existing.deathYear);
      if (yearDiff > YEAR_TOLERANCE) {
        return true; // Death years conflict
      }
    }

    // Check if one is alive and one is dead (birth year + reasonable lifespan)
    if (extracted.deathYear && existing.birthYear && !existing.deathYear) {
      const currentYear = new Date().getFullYear();
      const existingAge = currentYear - existing.birthYear;
      const extractedDeathAge =
        extracted.deathYear - (extracted.birthYear || 0);

      // If existing person would be unreasonably old, and extracted has death year, possible conflict
      if (existingAge > 120 && extractedDeathAge < 120) {
        return true;
      }
    }

    return false; // No conflict detected
  }

  /**
   * Convert repository confidence level to numeric score.
   */
  private convertConfidence(confidence: 'high' | 'medium' | 'low'): number {
    switch (confidence) {
      case 'high':
        return 1.0;
      case 'medium':
        return 0.85;
      case 'low':
        return 0.7;
      default:
        return 0.5;
    }
  }

  /**
   * Determine which aliases should be suggested for addition.
   */
  private getSuggestedAliases(
    extracted: ExtractedPerson,
    existingName: string,
    existingAliases: string[],
  ): string[] {
    const suggested: string[] = [];
    const allExisting = [
      existingName.toLowerCase(),
      ...existingAliases.map((a) => a.toLowerCase()),
    ];

    // Add extracted name if it's not already in the existing entity
    if (!allExisting.includes(extracted.name.toLowerCase())) {
      suggested.push(extracted.name);
    }

    // Add extracted aliases if they're not already present
    for (const alias of extracted.aliases || []) {
      if (!allExisting.includes(alias.toLowerCase())) {
        suggested.push(alias);
      }
    }

    return suggested;
  }

  /**
   * Calculate confidence for place match based on similarity.
   */
  private calculatePlaceMatchConfidence(
    extracted: ExtractedPlace,
    existing: any,
  ): number {
    let score = 0;

    // Name similarity (Levenshtein or simple comparison)
    const nameSimilarity = this.stringSimilarity(extracted.name, existing.name);
    score += nameSimilarity * 0.5;

    // City match
    if (extracted.city && existing.city) {
      if (extracted.city.toLowerCase() === existing.city.toLowerCase()) {
        score += 0.25;
      }
    }

    // Country match
    if (extracted.country && existing.country) {
      if (extracted.country.toLowerCase() === existing.country.toLowerCase()) {
        score += 0.25;
      }
    }

    return Math.min(1.0, score);
  }

  /**
   * Simple string similarity (Dice coefficient).
   */
  private stringSimilarity(str1: string, str2: string): number {
    const s1 = str1.toLowerCase();
    const s2 = str2.toLowerCase();

    if (s1 === s2) return 1.0;
    if (s1.length < 2 || s2.length < 2) return 0;

    const firstBigrams = new Map<string, number>();
    for (let i = 0; i < s1.length - 1; i++) {
      const bigram = s1.substring(i, i + 2);
      const count = firstBigrams.get(bigram) || 0;
      firstBigrams.set(bigram, count + 1);
    }

    let intersectionSize = 0;
    for (let i = 0; i < s2.length - 1; i++) {
      const bigram = s2.substring(i, i + 2);
      const count = firstBigrams.get(bigram) || 0;
      if (count > 0) {
        firstBigrams.set(bigram, count - 1);
        intersectionSize++;
      }
    }

    return (2.0 * intersectionSize) / (s1.length + s2.length - 2);
  }

  /**
   * Find place by hierarchical matching (city + country).
   */
  private async findPlaceByHierarchy(
    familyId: string,
    extracted: ExtractedPlace,
  ): Promise<any> {
    const { data } = await this.placeRepo['client']
      .from('places')
      .select('*')
      .eq('family_id', familyId)
      .eq('redacted', false);

    if (!data) return null;

    for (const place of data) {
      // Match on city AND country
      if (extracted.city && extracted.country) {
        if (
          place.city?.toLowerCase() === extracted.city.toLowerCase() &&
          place.country?.toLowerCase() === extracted.country.toLowerCase()
        ) {
          return place;
        }
      }

      // Match on country only for country-level places
      if (extracted.country && !extracted.city && place.type === 'country') {
        if (place.country?.toLowerCase() === extracted.country.toLowerCase()) {
          return place;
        }
      }
    }

    return null;
  }

  // TODO: Implement LLM-based verification for uncertain matches
  // private async verifyMatchWithLlm(
  //   extracted: ExtractedPerson,
  //   candidate: Person,
  // ): Promise<boolean> {
  //   // Use LLM to determine if extracted person is the same as candidate
  //   // Consider context, aliases, relationships, etc.
  //   return false;
  // }
}
