import { Confidence } from './confidence.js';
import { LanguageCode } from './languages.js';

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
 * A claim extracted from a message.
 */
export interface ExtractedClaim {
  claimType: string;
  subject: string;
  claimValue: Record<string, unknown>;
  confidence: Confidence;
  certaintyLanguage?: string;
  contextOriginal?: string;
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
