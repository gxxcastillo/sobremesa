import { Confidence } from './confidence';
import { LanguageCode } from './languages';
import { ClaimSourceType } from './domain-model';

/**
 * Base entity interface with common fields.
 */
export interface BaseEntity {
  id: string;
  familyId: string;
  createdAt: Date;
  updatedAt: Date;
  redacted: boolean;
  redactedAt?: Date;
  redactedBy?: string;
  redactionReason?: string;
  contentHmac?: string;
  /** Version of extraction logic that created this record (e.g., scribe-v1.0.0) */
  extractionVersion?: string;
}

/**
 * A person mentioned in family history.
 */
export interface Person extends BaseEntity {
  name: string;
  aliases: string[];
  birthYear?: number;
  birthYearConfidence?: Confidence;
  deathYear?: number;
  deathYearConfidence?: Confidence;
  notesOriginal?: string;
  languageOriginal?: LanguageCode;
  firstMentionedEventId?: string;
  createdBy?: string;
  /** True if this person is a placeholder for an unknown individual in the family tree. */
  isPlaceholder?: boolean;
  // Phase 1b: Entity merge tracking
  /** ID of entity this was merged into */
  supersededBy?: string;
  /** When this entity was merged */
  supersededAt?: Date;
}

/**
 * A geographic location.
 */
export interface Place extends BaseEntity {
  name: string;
  type?: 'city' | 'country' | 'address' | 'region' | 'landmark' | string;
  city?: string;
  region?: string;
  country?: string;
  contextOriginal?: string;
  languageOriginal?: LanguageCode;
  firstMentionedEventId?: string;
  // Phase 1b: Entity merge tracking
  /** ID of entity this was merged into */
  supersededBy?: string;
  /** When this entity was merged */
  supersededAt?: Date;
}

/**
 * A timeline event.
 */
export interface TimelineEvent extends BaseEntity {
  title: string;
  eventType?:
    | 'immigration'
    | 'birth'
    | 'death'
    | 'marriage'
    | 'business'
    | string;
  descriptionOriginal?: string;
  descriptionLanguage?: LanguageCode;
  dateText?: string;
  dateYear?: number;
  // Note: People associations now in event_people join table
  placeId?: string;
  conversationEventId?: string;
  claimedBy?: string;
  // Phase 1b: Entity merge tracking
  /** ID of entity this was merged into */
  supersededBy?: string;
  /** When this entity was merged */
  supersededAt?: Date;
}

/**
 * A coherent narrative fragment.
 */
export interface Story extends BaseEntity {
  title?: string;
  contentOriginal: string;
  contentLanguage: LanguageCode;
  themes: string[];
  timeframe?: string;
  completeness: 'partial' | 'complete' | 'fragmentary';
  confidence: Confidence;
  // Note: Entity associations now in story_people/places/events join tables
  // Note: Source provenance now in story_conversation_events join table
  /** @deprecated Use story_conversation_events join table instead */
  conversationEventIds?: string[];
  sharedBy?: string;
  // Phase 1b: Entity merge tracking
  /** ID of entity this was merged into */
  supersededBy?: string;
  /** When this entity was merged */
  supersededAt?: Date;
}

/**
 * An atomic factual claim with provenance.
 * Note: Claim uses `status: 'redacted'` instead of the boolean `redacted` field.
 */
export interface Claim extends Omit<BaseEntity, 'redacted'> {
  claimType:
    | 'date'
    | 'location'
    | 'relationship'
    | 'detail'
    | 'identity'
    | string;
  subject: string;
  claimValue: Record<string, unknown>;
  conversationEventId: string;
  claimedBy: string;
  /** How the claim was attributed: direct (speaker), attributed (citing someone), hearsay (vague) */
  claimedBySource: ClaimSourceType;
  claimedAt: Date;
  confidence: Confidence;
  certaintyLanguage?: string;
  contextOriginal?: string;
  languageOriginal?: LanguageCode;
  // Note: Entity associations now in claim_entities join table

  // Lifecycle (only mutable field - operational necessity)
  status: 'active' | 'superseded' | 'disputed' | 'redacted';
}

/**
 * System-computed analysis for a claim.
 * Separated from immutable claim provenance - can be recomputed without touching source claims.
 * Does not extend BaseEntity as it has no redaction concept (it's metadata, not data).
 */
export interface ClaimAnalysis {
  id: string;
  familyId: string;
  claimId: string;
  inferenceMethod?: 'direct' | 'logical_inference' | 'llm_inference';
  claimStrength?: number; // 0.0-1.0 (system confidence)
  strengthFactors?: {
    algorithmScore: number;
    breakdown: Record<string, number>;
    llmScore?: number;
    llmReasoning?: string;
    final: number;
    evaluationTriggered?: string[];
  };
  needsLlmEvaluation?: boolean; // Flag: should this be queued for LLM review?
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Claim with analysis data joined (for services that need both).
 */
export interface ClaimWithAnalysis extends Claim {
  analysis?: ClaimAnalysis;
}

/**
 * Relationship categories.
 */
export type RelationshipCategory =
  | 'biological' // Blood relations
  | 'legal' // Adoption, marriage, legal guardianship
  | 'functional' // Raised by, de facto guardian
  | 'honorary' // Godparent, "uncle" by respect, padrino
  | 'social'; // Family friend, mentor, best friend

/**
 * Relationship status.
 */
export type RelationshipStatus =
  | 'active' // Currently active
  | 'ended' // Divorced, separated, estranged
  | 'deceased'; // Ended due to death

/**
 * Core relationship types (structural backbone of the family tree).
 */
export type CoreRelationshipType = 'parent' | 'spouse';

/**
 * Extended relationship types (non-structural, narrative relationships).
 */
export type ExtendedRelationshipType =
  | 'guardian' // Legal or de facto guardian
  | 'godparent' // Religious/cultural godparent
  | 'mentor' // Mentor relationship
  | 'friend' // Close family friend
  | 'caregiver'; // Caregiver role

/**
 * All relationship types.
 */
export type RelationshipType =
  | CoreRelationshipType
  | ExtendedRelationshipType
  | string;

/**
 * A relationship between two people.
 *
 * For 'parent' relationships: personA is the parent, personB is the child.
 * For 'spouse' relationships: order is normalized by UUID.
 * For other types: personA is the role-holder (godparent, mentor), personB is the recipient.
 */
export interface Relationship {
  id: string;
  familyId: string;
  personAId: string;
  personBId: string;
  /** The type of relationship (parent, spouse, godparent, etc.) */
  relationshipType: RelationshipType;
  /** Category: biological, legal, functional, honorary, social */
  category: RelationshipCategory;
  /** Status: active, ended, deceased */
  status: RelationshipStatus;
  /** Qualifier for nuance: half, step, adoptive, maternal, paternal, etc. */
  qualifier?: string;
  confidence: Confidence;
  conversationEventId?: string;
  claimedBy?: string;
  descriptionOriginal?: string;
  languageOriginal?: LanguageCode;
  createdAt: Date;
  /** Version of extraction logic that created this record (e.g., scribe-v1.0.0) */
  extractionVersion?: string;
}

/**
 * A photo, document, or video.
 */
export interface Image extends BaseEntity {
  source: string;
  externalFileId: string;
  fileType?: 'photo' | 'document' | 'video';
  fileSizeBytes?: number;
  captionOriginal?: string;
  languageOriginal?: LanguageCode;
  analysis?: Record<string, unknown>;
  peopleCount?: number;
  estimatedEra?: string;
  visibleText: string[];
  connectedStories: string[];
  connectedPeople: string[];
  conversationEventId: string;
  sharedBy?: string;
  analyzed: boolean;
  analyzedAt?: Date;
}

/**
 * A question in the facilitator queue.
 */
export interface Question {
  id: string;
  familyId: string;
  contentOriginal: string;
  languageOriginal: LanguageCode;
  origin: 'curator' | 'human';
  status: 'proposed' | 'asked' | 'answered' | 'retired';
  priority: number;
  sourceMessageId?: string;
  askedByIdentityId?: string;
  askedAt?: Date;
  answeredAt?: Date;
  answerMessageId?: string;
  askedExternalMessageId?: string; // External message ID for answer detection
  /** Name of the person this question should be directed to */
  targetPerson?: string;
  /** Name/title of the event this question relates to */
  targetEvent?: string;
  /** Name of the place this question relates to */
  targetPlace?: string;
  /** Brief context about the story this question aims to enrich */
  storyContext?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Entity merge record (active merges, deletable to undo).
 */
export interface EntityMerge {
  id: string;
  familyId: string;
  /** Entity being merged away */
  sourceEntityId: string;
  sourceEntityType: 'person' | 'place' | 'event' | 'story';
  /** Entity being kept */
  targetEntityId: string;
  targetEntityType: 'person' | 'place' | 'event' | 'story';
  /** How merge was determined */
  mergeStrategy?: 'fuzzy_match' | 'identity_claim' | 'manual' | 'llm_resolved';
  /** Merge confidence 0.00-1.00 */
  confidence?: number;
  /** Event that triggered this merge */
  triggerEventId?: string;
  /** Who performed the merge */
  mergedBy?: 'registrar' | 'curator' | 'admin' | 'llm_resolver';
  /** Human-readable explanation */
  mergeReason?: string;
  createdAt: Date;
}

/**
 * Many-to-many claim-entity relationship with identity resolution support.
 */
export interface ClaimEntity {
  id: string;
  familyId: string;
  claimId: string;
  entityId: string;
  entityType: 'person' | 'place' | 'event' | 'story' | 'relationship';
  /** Entity role: subject, related, identity_source, identity_target, location, witness */
  role?: string;
  /** For identity claims: whether identity has been resolved */
  resolved?: boolean;
  /** Links to merge decision for identity claims */
  entityMergeId?: string;
  /** Extended metadata (JSONB) - for identity: descriptive_name, canonical_name */
  relationshipMetadata?: Record<string, unknown>;
  createdAt: Date;
}

/**
 * Relationship between claims (supports, contradicts, refines, supersedes, derived_from).
 */
export interface ClaimRelationship {
  familyId: string;
  claimId: string;
  relatedClaimId: string;
  /** Type: supports, contradicts, refines, supersedes, derived_from */
  relationshipType:
    | 'supports'
    | 'contradicts'
    | 'refines'
    | 'supersedes'
    | 'derived_from';
  createdAt: Date;
}

/**
 * Story People - Many-to-many: stories ↔ people
 */
export interface StoryPerson {
  familyId: string;
  storyId: string;
  personId: string;
  createdAt: Date;
}

/**
 * Story Places - Many-to-many: stories ↔ places
 */
export interface StoryPlace {
  familyId: string;
  storyId: string;
  placeId: string;
  createdAt: Date;
}

/**
 * Story Events - Many-to-many: stories ↔ events
 */
export interface StoryEvent {
  familyId: string;
  storyId: string;
  eventId: string;
  createdAt: Date;
}

/**
 * Event People - Many-to-many: events ↔ people
 */
export interface EventPerson {
  familyId: string;
  eventId: string;
  personId: string;
  createdAt: Date;
}

/**
 * Event Places - Many-to-many: events ↔ places
 */
export interface EventPlace {
  familyId: string;
  eventId: string;
  placeId: string;
  createdAt: Date;
}

/**
 * Story Conversation Events - Many-to-many: stories ↔ conversation_events (provenance)
 */
export interface StoryConversationEvent {
  familyId: string;
  storyId: string;
  conversationEventId: string;
  createdAt: Date;
}
