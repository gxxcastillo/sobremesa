import type {
  Person,
  Claim,
  TimelineEvent,
  Story,
  Relationship,
  Confidence,
  ClaimSourceType,
} from '@sobremesa/shared-types';
import { PersonRepository } from '../repositories/person-repository.js';
import { PlaceRepository } from '../repositories/place-repository.js';
import { ClaimRepository } from '../repositories/claim-repository.js';
import { ClaimEntityRepository } from '../repositories/claim-entity-repository.js';
import { EntityMergeRepository } from '../repositories/entity-merge-repository.js';
import { TimelineEventRepository } from '../repositories/timeline-event-repository.js';
import { StoryRepository } from '../repositories/story-repository.js';
import { RelationshipRepository } from '../repositories/relationship-repository.js';

/**
 * Lightweight person context for entity matching.
 */
export interface PersonContext {
  id: string;
  name: string;
  aliases: string[];
  birthYear?: number;
  deathYear?: number;
  isPlaceholder?: boolean;
}

/**
 * Lightweight place context for entity matching.
 */
export interface PlaceContext {
  id: string;
  name: string;
  type?: string;
  city?: string;
  country?: string;
}

/**
 * Lightweight claim context for conflict detection.
 */
export interface ClaimContext {
  id: string;
  claimType: string;
  subject: string;
  claimValue: Record<string, unknown>;
  claimedBy: string;
  claimedBySource?: ClaimSourceType;
  confidence: Confidence;
  certaintyLanguage?: string;
  status: string;
}

/**
 * Shared data retrieval service used by both Registrar services and Historian.
 * Provides higher-level query methods with merge-aware logic.
 */
export class DataRetrieverService {
  constructor(
    private personRepo: PersonRepository,
    private placeRepo: PlaceRepository,
    private claimRepo: ClaimRepository,
    private claimEntityRepo: ClaimEntityRepository,
    private entityMergeRepo: EntityMergeRepository,
    private timelineEventRepo: TimelineEventRepository,
    private storyRepo: StoryRepository,
    private relationshipRepo: RelationshipRepository,
  ) {}

  // ============================================================================
  // Entity Context (for Registrar's EntityMatcher)
  // ============================================================================

  /**
   * Get lightweight person context for entity matching.
   * Returns only active (non-superseded) people.
   */
  async getPeopleContext(familyId: string): Promise<PersonContext[]> {
    const people = await this.personRepo.findAllActive(familyId);
    return people.map((p: Person) => ({
      id: p.id,
      name: p.name,
      aliases: p.aliases,
      birthYear: p.birthYear,
      deathYear: p.deathYear,
      isPlaceholder: p.isPlaceholder,
    }));
  }

  /**
   * Get lightweight place context for entity matching.
   * Returns only active (non-superseded) places.
   */
  async getPlacesContext(familyId: string): Promise<PlaceContext[]> {
    const places = await this.placeRepo.findAllActive(familyId);
    return places.map((p: any) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      city: p.city,
      country: p.country,
    }));
  }

  // ============================================================================
  // Claim Context (for Registrar's ConflictDetector)
  // ============================================================================

  /**
   * Get all active claims for a given subject (e.g., "Maria Garcia").
   * Used for conflict detection.
   */
  async getClaimsForSubject(
    familyId: string,
    subject: string,
  ): Promise<ClaimContext[]> {
    const claims = await this.claimRepo.findBySubject(familyId, subject);
    return claims
      .filter((c) => c.status === 'active')
      .map((c) => this.mapToClaimContext(c));
  }

  /**
   * Get all active claims for an entity.
   * Does NOT follow merge chain - use getClaimsForEntityIncludingMerged for that.
   */
  async getActiveClaimsForEntity(
    familyId: string,
    entityId: string,
    entityType: string,
  ): Promise<ClaimContext[]> {
    const claimEntities = await this.claimEntityRepo.findByEntity(
      familyId,
      entityType,
      entityId,
    );
    const claimIds = claimEntities.map((ce) => ce.claimId);

    if (claimIds.length === 0) return [];

    // Fetch claims in bulk
    const claims = await Promise.all(
      claimIds.map((claimId) => this.claimRepo.findById(familyId, claimId)),
    );

    return claims
      .filter((c): c is Claim => c !== null && c.status === 'active')
      .map((c) => this.mapToClaimContext(c));
  }

  // ============================================================================
  // Merge-Aware Queries (for both Registrar and Historian)
  // ============================================================================

  /**
   * Get the merge chain for an entity (all entities merged into this one).
   * Returns array of entity IDs including the target entity itself.
   * Uses database function get_entity_merge_chain().
   */
  async getEntityMergeChain(
    familyId: string,
    entityId: string,
    entityType: string,
  ): Promise<string[]> {
    return this.entityMergeRepo.getMergeChain(familyId, entityId, entityType);
  }

  /**
   * Get all claims for an entity including claims about merged predecessors.
   * Example: If "Dexter's ex-wife" was merged into "Judy Dor", this returns
   * claims about both entities.
   */
  async getClaimsForEntityIncludingMerged(
    familyId: string,
    entityId: string,
    entityType: string,
  ): Promise<Claim[]> {
    // Get all entity IDs in the merge chain
    const entityIds = await this.getEntityMergeChain(
      familyId,
      entityId,
      entityType,
    );

    if (entityIds.length === 0) return [];

    // Find all claim_entities linking to any entity in the chain
    const claimEntitiesPromises = entityIds.map((id) =>
      this.claimEntityRepo.findByEntity(familyId, entityType, id),
    );
    const claimEntitiesArrays = await Promise.all(claimEntitiesPromises);
    const claimEntities = claimEntitiesArrays.flat();

    // Get unique claim IDs
    const claimIds = [...new Set(claimEntities.map((ce) => ce.claimId))];

    if (claimIds.length === 0) return [];

    // Fetch claims in bulk
    const claimsPromises = claimIds.map((claimId) =>
      this.claimRepo.findById(familyId, claimId),
    );
    const claims = await Promise.all(claimsPromises);

    return claims.filter((c): c is Claim => c !== null);
  }

  /**
   * Get full person data with related entities (relationships, claims, events, stories).
   * Useful for "tell me about Maria" type questions.
   */
  async getPersonWithRelatedData(
    familyId: string,
    personId: string,
  ): Promise<{
    person: Person | null;
    relationships: Relationship[];
    claims: Claim[];
    events: TimelineEvent[];
    stories: Story[];
  }> {
    const [person, relationships, claims, events, stories] = await Promise.all([
      this.personRepo.findById(familyId, personId),
      this.relationshipRepo.findByPerson(familyId, personId),
      this.getClaimsForEntityIncludingMerged(familyId, personId, 'person'),
      this.timelineEventRepo.findByPerson(familyId, personId), // TODO: Make merge-aware
      this.storyRepo.findByPerson(familyId, personId), // TODO: Make merge-aware
    ]);

    return {
      person,
      relationships,
      claims,
      events,
      stories,
    };
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Map full Claim to lightweight ClaimContext.
   */
  private mapToClaimContext(claim: Claim): ClaimContext {
    return {
      id: claim.id,
      claimType: claim.claimType,
      subject: claim.subject,
      claimValue: claim.claimValue,
      claimedBy: claim.claimedBy,
      claimedBySource: claim.claimedBySource,
      confidence: claim.confidence,
      certaintyLanguage: claim.certaintyLanguage,
      status: claim.status,
    };
  }
}
