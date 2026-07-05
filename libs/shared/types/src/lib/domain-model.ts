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
  dateText?: string;
  dateYear?: number;
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
  claimValue: string | Record<string, unknown>;
  /**
   * Verbatim span from the current message supporting the claim. Required in
   * the Scribe LLM contract (schema fails loud without it); optional here so
   * non-Scribe constructors (tests, fixtures) can omit it — the Registrar
   * treats a missing/unmatchable span as a grounding failure to flag, never
   * as grounds to reject.
   */
  evidence?: string;
  confidence: Confidence;
  certaintyLanguage?: string;
  contextOriginal?: string;
  /** How the claim was attributed: direct (speaker), attributed (citing someone), hearsay (vague) */
  claimedBySource: ClaimSourceType;
  /**
   * The person the speaker attributes this claim to, set only when
   * claimedBySource is 'attributed' or 'hearsay' (e.g. "Mom always said..."
   * -> attributedTo: "Mom"). Never the deterministic sender — that is
   * pipeline-stamped, not LLM-derived.
   */
  attributedTo?: string;

  /** Names of people referenced in this claim */
  referencedPeople?: string[];
  /** Names of places referenced in this claim */
  referencedPlaces?: string[];
}

/**
 * A question generated about missing information.
 */
export interface GeneratedQuestion {
  content: string;
  language: LanguageCode;
  priority: number;
  origin: 'curator';
  targetPerson?: string;
  targetEvent?: string;
  targetPlace?: string;
  /** Brief context about the story this question aims to enrich */
  storyContext?: string;
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
  peopleIdentified: string[];
  /** Additional context provided about the image */
  contextProvided?: string;
  /** Confidence in this reference */
  confidence: Confidence;
}

/**
 * Ambiguous reference detected during interpretation.
 */
export interface AmbiguousReference {
  token: string;
  candidates: string[];
  selected: string;
  confidence: number;
}

/**
 * Interpretation metadata from Scribe's understood_message.
 */
export interface InterpretationMetadata {
  resolvedText: string;
  ambiguousReferences: AmbiguousReference[];
  resolutionConfidence: 'high' | 'medium' | 'low' | 'ambiguous';
}

/**
 * Complete domain model output from Scribe.
 */
export interface ScribeDomainModel {
  conversationEventId: string;
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

  // Image references detected
  imageReferences: ImageReference[];

  // Language detection (optional - provided by Intern preprocessing)
  detectedLanguage?: LanguageCode;

  // Extraction version for event sourcing (e.g., scribe-v1.0.0)
  extractionVersion?: string;

  // Interpretation metadata (optional, for debugging/audit)
  interpretation?: InterpretationMetadata;
}

/**
 * Domain model output from Curator (image analysis).
 */
export interface CuratorDomainModel {
  conversationEventId: string;
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
