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

  // Processing state
  processed: boolean;
  processedAt?: Date;
  processingError?: string;

  // Privacy
  redacted: boolean;
  redactedAt?: Date;
  redactedBy?: string;
  redactionReason?: string;

  // Integrity
  contentHmac?: string;

  // Timestamps
  occurredAt: Date;
  ingestedAt: Date;
}

/**
 * An identity from a chat provider.
 */
export interface Identity {
  id: string;
  familyId: string;
  source: ChatProvider;
  providerUserId: string;
  displayName?: string;
  username?: string;
  personId?: string;
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
