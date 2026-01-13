import { createLogger } from '@sobremesa/shared-utils';
import { detectLanguage, type ChatProvider } from '@sobremesa/shared-types';
import {
  ConversationEventRepository,
  ProcessingQueueRepository,
  EventLogRepository,
} from '@sobremesa/database';
import type pino from 'pino';

/**
 * Actor information from any chat provider.
 */
export interface ActorInfo {
  externalId: string;
  displayName: string;
  username?: string;
}

/**
 * Base message input for ingestion (platform-agnostic).
 */
export interface BaseMessageInput {
  source: ChatProvider;
  conversationId: string;
  externalEventId: string;
  externalReplyToId?: string;
  actor: ActorInfo;
  occurredAt: Date;
  metadata?: Record<string, unknown>;
  sourcePayload?: Record<string, unknown>;
}

/**
 * Text message input.
 */
export interface TextMessageInput extends BaseMessageInput {
  type: 'text';
  text: string;
}

/**
 * Photo message input.
 */
export interface PhotoMessageInput extends BaseMessageInput {
  type: 'photo';
  caption?: string;
  fileId: string;
  fileUniqueId: string;
  width?: number;
  height?: number;
  fileSize?: number;
}

/**
 * Document message input.
 */
export interface DocumentMessageInput extends BaseMessageInput {
  type: 'document';
  caption?: string;
  fileId: string;
  fileUniqueId: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
}

/**
 * Video message input.
 */
export interface VideoMessageInput extends BaseMessageInput {
  type: 'video';
  caption?: string;
  fileId: string;
  fileUniqueId: string;
  width?: number;
  height?: number;
  duration?: number;
  mimeType?: string;
  fileSize?: number;
  thumbnail?: {
    fileId: string;
    fileUniqueId: string;
    width?: number;
    height?: number;
  };
}

/**
 * Union type for all media message inputs.
 */
export type MediaMessageInput = PhotoMessageInput | DocumentMessageInput | VideoMessageInput;

/**
 * Platform-agnostic message ingester.
 * Handles deduplication, event creation, and queue enqueue.
 */
export class MessageIngester {
  private eventRepo: ConversationEventRepository;
  private queueRepo: ProcessingQueueRepository;
  private eventLog: EventLogRepository;
  private logger: pino.Logger;

  constructor(logger?: pino.Logger) {
    this.eventRepo = new ConversationEventRepository();
    this.queueRepo = new ProcessingQueueRepository();
    this.eventLog = new EventLogRepository();
    this.logger = logger || createLogger({ name: 'ingester' });
  }

  /**
   * Ingest a text message from any provider.
   * Returns the event ID if created, null if duplicate.
   */
  async ingestTextMessage(familyId: string, input: TextMessageInput): Promise<string | null> {
    this.logger.debug(
      { conversationId: input.conversationId, eventId: input.externalEventId, from: input.actor.username },
      'Ingesting text message'
    );

    // Check for duplicates
    const existing = await this.eventRepo.findByExternalId(
      familyId,
      input.source,
      input.conversationId,
      input.externalEventId
    );

    if (existing) {
      this.logger.debug({ eventId: input.externalEventId }, 'Message already exists, skipping');
      return null;
    }

    // Create conversation event
    const event = await this.eventRepo.insert({
      familyId,
      source: input.source,
      conversationId: input.conversationId,
      externalEventId: input.externalEventId,
      externalReplyToId: input.externalReplyToId,
      actorExternalId: input.actor.externalId,
      actorDisplayName: input.actor.displayName,
      actorUsername: input.actor.username,
      eventType: 'message',
      contentOriginal: input.text,
      languageOriginal: detectLanguage(input.text),
      metadata: input.metadata,
      sourcePayload: input.sourcePayload,
      processed: false,
      redacted: false,
      occurredAt: input.occurredAt,
      ingestedAt: new Date(),
    });

    // Enqueue for processing
    await this.queueRepo.enqueue(familyId, event.id);

    // Log the event
    await this.eventLog.log({
      familyId,
      eventType: 'event_ingested',
      eventCategory: 'user_action',
      actor: input.actor.username || input.actor.externalId,
      actorType: 'user',
      sourceEventId: event.id,
      eventData: {
        messageType: 'text',
        textLength: input.text.length,
        language: detectLanguage(input.text),
      },
    });

    this.logger.info(
      { eventId: event.id, externalEventId: input.externalEventId },
      'Text message ingested and queued'
    );

    return event.id;
  }

  /**
   * Ingest a photo message from any provider.
   * Returns the event ID if created, null if duplicate.
   */
  async ingestPhotoMessage(familyId: string, input: PhotoMessageInput): Promise<string | null> {
    this.logger.debug(
      { conversationId: input.conversationId, eventId: input.externalEventId },
      'Ingesting photo message'
    );

    // Check for duplicates
    const existing = await this.eventRepo.findByExternalId(
      familyId,
      input.source,
      input.conversationId,
      input.externalEventId
    );

    if (existing) {
      this.logger.debug({ eventId: input.externalEventId }, 'Photo already exists, skipping');
      return null;
    }

    // Build metadata
    const metadata: Record<string, unknown> = {
      ...input.metadata,
      fileId: input.fileId,
      fileUniqueId: input.fileUniqueId,
      width: input.width,
      height: input.height,
      fileSize: input.fileSize,
    };

    // Create conversation event
    const event = await this.eventRepo.insert({
      familyId,
      source: input.source,
      conversationId: input.conversationId,
      externalEventId: input.externalEventId,
      externalReplyToId: input.externalReplyToId,
      actorExternalId: input.actor.externalId,
      actorDisplayName: input.actor.displayName,
      actorUsername: input.actor.username,
      eventType: 'photo',
      contentOriginal: input.caption || undefined,
      languageOriginal: input.caption ? detectLanguage(input.caption) : undefined,
      metadata,
      sourcePayload: input.sourcePayload,
      processed: false,
      redacted: false,
      occurredAt: input.occurredAt,
      ingestedAt: new Date(),
    });

    // Enqueue for processing
    await this.queueRepo.enqueue(familyId, event.id);

    // Log the event
    await this.eventLog.log({
      familyId,
      eventType: 'event_ingested',
      eventCategory: 'user_action',
      actor: input.actor.username || input.actor.externalId,
      actorType: 'user',
      sourceEventId: event.id,
      eventData: {
        messageType: 'photo',
        hasCaption: !!input.caption,
        photoSize: input.fileSize,
      },
    });

    this.logger.info(
      { eventId: event.id, externalEventId: input.externalEventId },
      'Photo message ingested and queued'
    );

    return event.id;
  }

  /**
   * Ingest a document message from any provider.
   * Returns the event ID if created, null if duplicate.
   */
  async ingestDocumentMessage(familyId: string, input: DocumentMessageInput): Promise<string | null> {
    this.logger.debug(
      { conversationId: input.conversationId, eventId: input.externalEventId },
      'Ingesting document message'
    );

    // Check for duplicates
    const existing = await this.eventRepo.findByExternalId(
      familyId,
      input.source,
      input.conversationId,
      input.externalEventId
    );

    if (existing) {
      this.logger.debug({ eventId: input.externalEventId }, 'Document already exists, skipping');
      return null;
    }

    // Build metadata
    const metadata: Record<string, unknown> = {
      ...input.metadata,
      fileId: input.fileId,
      fileUniqueId: input.fileUniqueId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      fileSize: input.fileSize,
    };

    // Create conversation event
    const event = await this.eventRepo.insert({
      familyId,
      source: input.source,
      conversationId: input.conversationId,
      externalEventId: input.externalEventId,
      externalReplyToId: input.externalReplyToId,
      actorExternalId: input.actor.externalId,
      actorDisplayName: input.actor.displayName,
      actorUsername: input.actor.username,
      eventType: 'document',
      contentOriginal: input.caption || undefined,
      languageOriginal: input.caption ? detectLanguage(input.caption) : undefined,
      metadata,
      sourcePayload: input.sourcePayload,
      processed: false,
      redacted: false,
      occurredAt: input.occurredAt,
      ingestedAt: new Date(),
    });

    // Enqueue for processing
    await this.queueRepo.enqueue(familyId, event.id);

    // Log the event
    await this.eventLog.log({
      familyId,
      eventType: 'event_ingested',
      eventCategory: 'user_action',
      actor: input.actor.username || input.actor.externalId,
      actorType: 'user',
      sourceEventId: event.id,
      eventData: {
        messageType: 'document',
        hasCaption: !!input.caption,
        mimeType: input.mimeType,
        fileName: input.fileName,
      },
    });

    this.logger.info(
      { eventId: event.id, externalEventId: input.externalEventId },
      'Document message ingested and queued'
    );

    return event.id;
  }

  /**
   * Ingest a video message from any provider.
   * Returns the event ID if created, null if duplicate.
   */
  async ingestVideoMessage(familyId: string, input: VideoMessageInput): Promise<string | null> {
    this.logger.debug(
      { conversationId: input.conversationId, eventId: input.externalEventId },
      'Ingesting video message'
    );

    // Check for duplicates
    const existing = await this.eventRepo.findByExternalId(
      familyId,
      input.source,
      input.conversationId,
      input.externalEventId
    );

    if (existing) {
      this.logger.debug({ eventId: input.externalEventId }, 'Video already exists, skipping');
      return null;
    }

    // Build metadata
    const metadata: Record<string, unknown> = {
      ...input.metadata,
      fileId: input.fileId,
      fileUniqueId: input.fileUniqueId,
      width: input.width,
      height: input.height,
      duration: input.duration,
      mimeType: input.mimeType,
      fileSize: input.fileSize,
      thumbnail: input.thumbnail,
    };

    // Create conversation event
    const event = await this.eventRepo.insert({
      familyId,
      source: input.source,
      conversationId: input.conversationId,
      externalEventId: input.externalEventId,
      externalReplyToId: input.externalReplyToId,
      actorExternalId: input.actor.externalId,
      actorDisplayName: input.actor.displayName,
      actorUsername: input.actor.username,
      eventType: 'video',
      contentOriginal: input.caption || undefined,
      languageOriginal: input.caption ? detectLanguage(input.caption) : undefined,
      metadata,
      sourcePayload: input.sourcePayload,
      processed: false,
      redacted: false,
      occurredAt: input.occurredAt,
      ingestedAt: new Date(),
    });

    // Enqueue for processing
    await this.queueRepo.enqueue(familyId, event.id);

    // Log the event
    await this.eventLog.log({
      familyId,
      eventType: 'event_ingested',
      eventCategory: 'user_action',
      actor: input.actor.username || input.actor.externalId,
      actorType: 'user',
      sourceEventId: event.id,
      eventData: {
        messageType: 'video',
        hasCaption: !!input.caption,
        duration: input.duration,
        mimeType: input.mimeType,
      },
    });

    this.logger.info(
      { eventId: event.id, externalEventId: input.externalEventId },
      'Video message ingested and queued'
    );

    return event.id;
  }
}
