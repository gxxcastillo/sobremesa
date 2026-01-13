/**
 * Configuration for the Scribe agent.
 */
export interface ScribeConfig {
  /** Claude model to use */
  model: string;
  /** Maximum tokens for response */
  maxTokens: number;
  /** Extraction thoroughness level */
  thoroughness: 'essential' | 'standard' | 'comprehensive';
  /** Confidence threshold for extraction */
  confidence: 'strict' | 'moderate' | 'lenient';
  /** Cultural terms to preserve (never translate) */
  culturalTerms: string[];
  /** Scribe name for prompts */
  scribeName: string;
}

/**
 * Default Scribe configuration.
 */
export const DEFAULT_SCRIBE_CONFIG: ScribeConfig = {
  model: 'claude-sonnet-4-20250514',
  maxTokens: 4096,
  thoroughness: 'standard',
  confidence: 'moderate',
  culturalTerms: [],
  scribeName: 'Scribe',
};

/**
 * Image context for Scribe.
 */
export interface ImageContext {
  /** Image ID (short form for referencing) */
  id: string;
  /** File type: photo, document, video */
  fileType: string;
  /** Who shared this image */
  sharedBy?: string;
  /** When it was shared */
  sharedAt: Date;
  /** Whether Curator has analyzed it */
  analyzed: boolean;
  /** Description from Curator analysis */
  description?: string;
  /** Number of people visible */
  peopleCount?: number;
  /** Estimated era/decade */
  estimatedEra?: string;
  /** Visible text extracted */
  visibleText?: string[];
}

/**
 * Context provided to Scribe for processing.
 * Note: People and places are no longer included - Registrar handles entity matching.
 */
export interface ScribeContext {
  /** Recent messages for context */
  recentMessages: Array<{
    content: string;
    senderName: string;
    occurredAt: Date;
  }>;
  /** Recent images shared in conversation */
  recentImages: ImageContext[];
  /** Pending questions to check for answers */
  pendingQuestions: Array<{
    id: string;
    content: string;
  }>;
  /** Recent claims for conflict detection */
  recentClaims: Array<{
    subject: string;
    claimValue: Record<string, unknown>;
    claimedBy: string;
  }>;
}

/**
 * Raw response from Claude before parsing.
 */
export interface RawScribeResponse {
  people: Array<{
    name: string;
    aliases?: string[];
    birth_year?: number;
    death_year?: number;
    confidence?: string;
  }>;
  places: Array<{
    name: string;
    type?: string;
    city?: string;
    region?: string;
    country?: string;
    confidence?: string;
  }>;
  events: Array<{
    title: string;
    event_type?: string;
    date_year?: number;
    date_month?: number;
    date_day?: number;
    date_approximate?: string;
    people_involved?: string[];
    place?: string;
    confidence?: string;
  }>;
  stories?: Array<{
    title?: string;
    content: string;
    themes?: string[];
    timeframe?: string;
  }>;
  claims: Array<{
    claim_type: string;
    subject: string;
    claim_value: Record<string, unknown>;
    confidence?: string;
    certainty_language?: string;
    context_original?: string;
    /** Who made this claim (person name or description) */
    claimed_by?: string;
    /** Source type: "direct" (speaker), "attributed" (citing someone), "hearsay" (vague source) */
    claimed_by_source?: string;
  }>;
  relationships?: Array<{
    person_a: string;
    person_b: string;
    relationship_type: string;
    confidence?: string;
  }>;
  questions: Array<{
    question_original: string;
    language_original?: string;
    question_type?: string;
    priority?: number;
    target_person?: string;
    target_event?: string;
    target_place?: string;
  }>;
  answered_questions?: Array<{
    question_id: string;
    completeness?: string;
  }>;
  conflicts?: Array<{
    subject: string;
    existing_claim_value?: Record<string, unknown>;
    new_claim_value?: Record<string, unknown>;
    conflict_type?: string;
  }>;
  image_references?: Array<{
    image_id: string;
    reference_type: string;
    people_identified?: string[];
    context_provided?: string;
    confidence?: string;
  }>;
  detected_language?: string;
}
