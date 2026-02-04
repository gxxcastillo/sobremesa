import { LanguageCode, type SupportedLanguage } from './languages';

/**
 * Supported chat providers.
 */
export type ChatProvider = 'telegram' | 'whatsapp' | 'sms' | string;

/**
 * Event types in a conversation.
 */
export type ConversationEventType =
  | 'message'
  | 'photo'
  | 'document'
  | 'video'
  | 'join'
  | 'leave'
  | 'edit';

/**
 * A raw conversation event from any chat provider.
 */
export interface ConversationEvent {
  id: string;
  familyId: string;
  sequenceNumber?: number;

  // Provider identity
  source: ChatProvider;
  conversationId: string;
  externalEventId: string;
  externalReplyToId?: string;

  // Actor snapshot
  actorExternalId: string;
  actorDisplayName?: string;
  actorUsername?: string;

  // Event classification
  eventType: ConversationEventType;

  // Content (original language only)
  contentOriginal?: string;
  languageOriginal?: LanguageCode;

  // Provider-specific metadata
  metadata?: Record<string, unknown>;
  sourcePayload?: Record<string, unknown>;

  // Integrity
  contentHmac?: string;

  // Timestamps
  occurredAt: Date;
  ingestedAt: Date;
}

/**
 * Raw image reference from preprocessing (before confidence scoring).
 */
export interface RawImageReference {
  imageId: string;
  referenceType:
    | 'describes'
    | 'identifies_people'
    | 'provides_context'
    | 'asks_about';
  peopleIdentified?: string[];
  contextProvided?: string;
}

/**
 * Interpretation metadata stored in processing records.
 */
export interface ProcessingInterpretation {
  resolvedText: string;
  ambiguousReferences: Array<{
    token: string;
    candidates: string[];
    selected: string;
    confidence: number;
  }>;
  resolutionConfidence: 'high' | 'medium' | 'low' | 'ambiguous';
}

/**
 * Processing metadata structure.
 */
export interface ProcessingMetadata {
  agentVersion?: string;
  tokenUsage?: { input: number; output: number };
  interpretation?: ProcessingInterpretation;
}

/**
 * Preprocessing artifacts for a conversation event.
 * Separate from ConversationEvent to keep original events fully immutable.
 * This table is mutable and can be reprocessed/updated.
 */
export interface ConversationEventProcessing {
  conversationEventId: string;
  familyId: string;

  // Preprocessing results
  detectedLanguage?: LanguageCode;
  imageReferences?: RawImageReference[];

  // Processing metadata
  processingMetadata?: ProcessingMetadata;
  processedAt: Date;
  processedBy?: string;
}

/**
 * A redaction record for a conversation event (non-destructive privacy control).
 * conversation_events remains immutable; redaction is tracked separately.
 */
export interface ConversationRedaction {
  id: string;
  familyId: string;
  conversationEventId: string;

  // Redaction metadata
  redactedAt: Date;
  redactedByIdentityId?: string;
  redactionReason: string;

  // Audit trail link
  eventLogId?: string;

  createdAt: Date;
}

/**
 * A global identity from a chat provider.
 *
 * Identities are global - one per provider account (e.g., Telegram user 12345).
 * They optionally link to a users table for cross-provider account linking.
 * Per-family relationships (including person claims) are in family_access.
 */
export interface Identity {
  id: string;
  /** Link to global user account (for cross-provider linking and web auth) */
  userId?: string;
  /** Chat provider: telegram, discord, whatsapp, etc. */
  provider: ChatProvider;
  /** User ID from the chat provider */
  providerUserId: string;
  /** Username from provider (@handle) */
  providerUsername?: string;
  /** Display name (latest known from provider) */
  displayName?: string;
  /** Avatar URL (latest known from provider) */
  avatarUrl?: string;
  /** Last login timestamp */
  lastLoginAt?: Date;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Configuration for a family's language and cultural settings.
 */
export interface FamilyLanguageConfig {
  /** Primary language for bot responses */
  primary: SupportedLanguage;
}

/**
 * Configuration for bot personalities.
 */
export interface FamilyBotConfig {
  facilitator?: {
    displayName?: string;
    personality?: {
      formality?: 'casual' | 'friendly' | 'professional' | 'formal';
      emojiUsage?: 'none' | 'minimal' | 'moderate' | 'generous';
      engagement?: 'gentle' | 'curious' | 'enthusiastic';
      verbosity?: 'concise' | 'moderate' | 'detailed';
      patience?: 'brief' | 'moderate' | 'extensive';
    };
  };
  admin?: {
    displayName?: string;
    personality?: {
      formality?: 'casual' | 'friendly' | 'professional' | 'formal';
      emojiUsage?: 'none' | 'minimal' | 'moderate' | 'generous';
      celebration?: 'understated' | 'warm' | 'enthusiastic';
    };
  };
  scribe?: {
    displayName?: string;
    personality?: {
      thoroughness?: 'essential' | 'standard' | 'comprehensive';
    };
  };
  historian?: {
    displayName?: string;
  };
}

/**
 * Complete family configuration stored in the config JSONB column.
 */
export interface FamilyConfig {
  /** Language settings */
  languages?: FamilyLanguageConfig;
  /** Bot personality configurations */
  bots?: FamilyBotConfig;
  /** Cultural terms to preserve (never translate) */
  culturalTerms?: string[];
  /** Project display name */
  projectName?: string;
}

/**
 * A family space (tenant).
 */
export interface Family {
  id: string;
  name: string;
  config: FamilyConfig;
  chatId?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}
