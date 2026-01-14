import { LanguageCode } from './languages';

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
 * A family space (tenant).
 */
export interface Family {
  id: string;
  name: string;
  config: Record<string, unknown>;
  chatId?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}
