import { Confidence } from './confidence';
import { LanguageCode } from './languages';

/**
 * Extracted entity from Scribe processing.
 */
export interface ExtractedPerson {
  name: string;
  aliases: string[];
  birthYear?: number;
  deathYear?: number;
  confidence: Confidence;
}

export interface ExtractedPlace {
  name: string;
  type?: string;
  city?: string;
  region?: string;
  country?: string;
  confidence: Confidence;
}

export interface ExtractedEvent {
  title: string;
  eventType?: string;
  dateYear?: number;
  dateMonth?: number;
  dateDay?: number;
  dateApproximate?: string;
  peopleInvolved: string[];
  placeName?: string;
  confidence: Confidence;
}

export interface ExtractedRelationship {
  personAName: string;
  personBName: string;
  relationshipType: string;
  confidence: Confidence;
}

/**
 * Source type for claim attribution.
 */
export type ClaimSourceType = 'direct' | 'attributed' | 'hearsay';

/**
 * A claim extracted from a message.
 */
export interface ExtractedClaim {
  claimType: string;
  subject: string;
  claimValue: Record<string, unknown>;
  confidence: Confidence;
  certaintyLanguage?: string;
  contextOriginal?: string;
  /** Who made this claim (extracted from message content) */
  claimedBy?: string;
  /** How the claim was attributed: direct (speaker), attributed (citing someone), hearsay (vague) */
  claimedBySource?: ClaimSourceType;
}

/**
 * A question generated about missing information.
 */
export interface GeneratedQuestion {
  content: string;
  language: LanguageCode;
  priority: number;
  origin: 'scribe' | 'curator';
  targetPerson?: string;
  targetEvent?: string;
  targetPlace?: string;
}

/**
 * Detection of an answer to a pending question.
 */
export interface DetectedAnswer {
  questionId: string;
  answerContent: string;
  confidence: Confidence;
}

/**
 * Conflict between claims.
 */
export interface DetectedConflict {
  existingClaimSubject: string;
  existingClaimValue: Record<string, unknown>;
  newClaimValue: Record<string, unknown>;
  conflictType: 'contradiction' | 'inconsistency';
}

/**
 * Reference from a message to an image.
 * Used when Scribe detects that a message is describing or referencing an image.
 */
export interface ImageReference {
  /** The image ID (short form from context) */
  imageId: string;
  /** How the message relates to the image */
  referenceType:
    | 'describes'
    | 'identifies_people'
    | 'provides_context'
    | 'asks_about';
  /** People identified in the image by this message */
  peopleIdentified?: string[];
  /** Additional context provided about the image */
  contextProvided?: string;
  /** Confidence in this reference */
  confidence: Confidence;
}

/**
 * Complete domain model output from Scribe.
 */
export interface ScribeDomainModel {
  sourceEventId: string;
  familyId: string;
  processedAt: Date;

  // Extracted content
  people: ExtractedPerson[];
  places: ExtractedPlace[];
  events: ExtractedEvent[];
  relationships: ExtractedRelationship[];
  claims: ExtractedClaim[];

  // Story fragment if detected
  story?: {
    title?: string;
    content: string;
    themes: string[];
    timeframe?: string;
  };

  // Questions generated
  questions: GeneratedQuestion[];

  // Answers detected
  answers: DetectedAnswer[];

  // Conflicts detected
  conflicts: DetectedConflict[];

  // Image references detected
  imageReferences: ImageReference[];

  // Language detection
  detectedLanguage: LanguageCode;
}

/**
 * Domain model output from Curator (image analysis).
 */
export interface CuratorDomainModel {
  sourceEventId: string;
  familyId: string;
  processedAt: Date;

  // Image analysis
  description: string;
  peopleCount?: number;
  estimatedEra?: string;
  visibleText: string[];

  // Connections to existing data
  possiblePeopleMatches: string[];
  possibleStoryConnections: string[];

  // Questions generated
  questions: GeneratedQuestion[];
}
