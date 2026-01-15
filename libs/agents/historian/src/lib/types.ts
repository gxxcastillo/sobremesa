import type {
  Confidence,
  Person,
  Relationship,
  SupportedLanguage,
} from '@sobremesa/shared-types';

/**
 * Types of questions the Historian can answer.
 */
export type QuestionType =
  | 'person_info' // "Tell me about grandpa Abraham"
  | 'relationship' // "How is Maria related to Roberto?"
  | 'timeline' // "When did the family come to America?"
  | 'location' // "Where did grandma grow up?"
  | 'event' // "What happened at the 1962 wedding?"
  | 'story' // "What's the story about the grocery store?"
  | 'verification' // "Is it true that...?"
  | 'general'; // Broad questions about family history

/**
 * Result of parsing a question.
 */
export interface ParsedQuestion {
  /** Original question text */
  original: string;
  /** Detected question type */
  type: QuestionType;
  /** Entity references extracted (names, places, etc.) */
  entities: string[];
  /** Time references if any */
  timeReferences: string[];
  /** Keywords for search */
  keywords: string[];
}

/**
 * A claim with its source information for display.
 */
export interface ClaimWithSource {
  id: string;
  subject: string;
  claimValue: unknown;
  confidence: Confidence;
  claimedBy: string;
  claimedBySource: 'direct' | 'attributed' | 'hearsay';
  certaintyLanguage?: string;
}

/**
 * A person with their associated claims.
 */
export interface PersonWithClaims {
  person: Person;
  claims: ClaimWithSource[];
}

/**
 * Timeline event for display.
 */
export interface TimelineEventInfo {
  id: string;
  title: string;
  eventType: string;
  dateYear?: number;
  dateMonth?: number;
  dateApproximate?: string;
  place?: string;
  peopleInvolved: string[];
  confidence: Confidence;
}

/**
 * Story summary for display.
 */
export interface StorySummary {
  id: string;
  title: string;
  content: string;
  themes: string[];
  timeframe?: string;
  peopleInvolved: string[];
}

/**
 * Image with identified people.
 */
export interface ImageInfo {
  id: string;
  description?: string;
  peopleIdentified: string[];
  estimatedEra?: string;
  sharedBy?: string;
}

/**
 * Retrieved context for answering a question.
 */
export interface RetrievedContext {
  /** People matching the query */
  people: PersonWithClaims[];
  /** Relevant timeline events */
  events: TimelineEventInfo[];
  /** Relevant stories */
  stories: StorySummary[];
  /** All relevant claims */
  claims: ClaimWithSource[];
  /** Relevant relationships */
  relationships: Relationship[];
  /** Relevant images */
  images: ImageInfo[];
  /** Whether any conflicts were found */
  hasConflicts: boolean;
  /** Conflicting claims grouped by subject */
  conflicts: Map<string, ClaimWithSource[]>;
}

/**
 * Configuration for the Historian agent.
 */
export interface HistorianConfig {
  /** Display name for the historian */
  historianName: string;
  /** Model to use */
  model: string;
  /** Maximum tokens for response */
  maxTokens: number;
  /** Maximum claims to retrieve per query */
  maxClaimsPerQuery: number;
  /** Maximum stories to include */
  maxStories: number;
  /** Maximum events to include */
  maxEvents: number;
  /** Whether to suggest follow-up questions */
  suggestFollowUps: boolean;
  /** Primary language for responses */
  primaryLanguage: SupportedLanguage;
}

/**
 * Default configuration for the Historian agent.
 */
export const DEFAULT_HISTORIAN_CONFIG: HistorianConfig = {
  historianName: 'El Bibliotecario',
  model: 'claude-sonnet-4-20250514',
  maxTokens: 1024,
  maxClaimsPerQuery: 20,
  maxStories: 5,
  maxEvents: 10,
  suggestFollowUps: true,
  primaryLanguage: 'en',
};

/**
 * Result of the Historian answering a question.
 */
export interface HistorianResult {
  /** Whether the question was answered successfully */
  success: boolean;
  /** The answer text */
  answer?: string;
  /** Question type that was detected */
  questionType?: QuestionType;
  /** Number of data points used in the answer */
  dataPointsUsed?: number;
  /** Whether conflicts were present in the answer */
  hasConflicts?: boolean;
  /** Error message if unsuccessful */
  error?: string;
  /** Tokens used for this call */
  tokensUsed?: number;
}
