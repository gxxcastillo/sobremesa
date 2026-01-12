import { Confidence } from './confidence.js';
import { LanguageCode } from './languages.js';
import { ClaimSourceType } from './domain-model.js';

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
}

/**
 * A timeline event.
 */
export interface TimelineEvent extends BaseEntity {
  title: string;
  eventType?: 'immigration' | 'birth' | 'death' | 'marriage' | 'business' | string;
  descriptionOriginal?: string;
  descriptionLanguage?: LanguageCode;
  dateYear?: number;
  dateMonth?: number;
  dateDay?: number;
  dateApproximate?: string;
  dateConfidence?: Confidence;
  peopleInvolved: string[];
  placeId?: string;
  sourceEventId?: string;
  claimedBy?: string;
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
  people: string[];
  places: string[];
  events: string[];
  sourceEventIds: string[];
  sharedBy?: string;
}

/**
 * An atomic factual claim with provenance.
 */
export interface Claim extends BaseEntity {
  claimType: 'date' | 'location' | 'relationship' | 'fact' | string;
  subject: string;
  claimValue: Record<string, unknown>;
  sourceEventId: string;
  claimedBy: string;
  /** How the claim was attributed: direct (speaker), attributed (citing someone), hearsay (vague) */
  claimedBySource?: ClaimSourceType;
  claimedAt: Date;
  confidence: Confidence;
  certaintyLanguage?: string;
  contextOriginal?: string;
  languageOriginal?: LanguageCode;
  entityId?: string;
  entityType?: 'person' | 'place' | 'event' | 'story';
  status: 'active' | 'superseded' | 'disputed' | 'redacted';
}

/**
 * Relationship categories.
 */
export type RelationshipCategory =
  | 'biological'  // Blood relations
  | 'legal'       // Adoption, marriage, legal guardianship
  | 'functional'  // Raised by, de facto guardian
  | 'honorary'    // Godparent, "uncle" by respect, padrino
  | 'social';     // Family friend, mentor, best friend

/**
 * Relationship status.
 */
export type RelationshipStatus =
  | 'active'      // Currently active
  | 'ended'       // Divorced, separated, estranged
  | 'deceased';   // Ended due to death

/**
 * Core relationship types (structural backbone of the family tree).
 */
export type CoreRelationshipType = 'parent' | 'spouse';

/**
 * Extended relationship types (non-structural, narrative relationships).
 */
export type ExtendedRelationshipType =
  | 'guardian'    // Legal or de facto guardian
  | 'godparent'   // Religious/cultural godparent
  | 'mentor'      // Mentor relationship
  | 'friend'      // Close family friend
  | 'caregiver';  // Caregiver role

/**
 * All relationship types.
 */
export type RelationshipType = CoreRelationshipType | ExtendedRelationshipType | string;

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
  sourceEventId?: string;
  claimedBy?: string;
  descriptionOriginal?: string;
  languageOriginal?: LanguageCode;
  createdAt: Date;
}

/**
 * A photo or document.
 */
export interface Image extends BaseEntity {
  source: string;
  externalFileId: string;
  fileType?: 'photo' | 'document';
  fileSizeBytes?: number;
  captionOriginal?: string;
  languageOriginal?: LanguageCode;
  analysis?: Record<string, unknown>;
  peopleCount?: number;
  estimatedEra?: string;
  visibleText: string[];
  connectedStories: string[];
  connectedPeople: string[];
  sourceEventId: string;
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
  origin: 'scribe' | 'curator' | 'human';
  status: 'proposed' | 'asked' | 'answered' | 'retired';
  priority: number;
  sourceMessageId?: string;
  askedByIdentityId?: string;
  askedAt?: Date;
  answeredAt?: Date;
  answerMessageId?: string;
  askedExternalMessageId?: string; // External message ID for answer detection
  createdAt: Date;
  updatedAt: Date;
}
