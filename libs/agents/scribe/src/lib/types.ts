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
 * Context provided to Scribe for processing.
 */
export interface ScribeContext {
  /** Recent messages for context */
  recentMessages: Array<{
    content: string;
    senderName: string;
    occurredAt: Date;
  }>;
  /** Existing people in the family */
  existingPeople: Array<{
    name: string;
    aliases: string[];
  }>;
  /** Existing places in the family */
  existingPlaces: Array<{
    name: string;
  }>;
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
  detected_language?: string;
}
