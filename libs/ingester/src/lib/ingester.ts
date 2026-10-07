import { createLogger } from '@sobremesa/shared-utils';
import {
  detectLanguage,
  type ChatProvider,
  type EnqueueOptions,
  Priorities,
} from '@sobremesa/shared-types';
import {
  ConversationEventRepository,
  ProcessingQueueRepository,
  EventLogRepository,
  IdentityRepository,
  type DatabaseClient,
} from '@sobremesa/database';
import type pino from 'pino';

/** Delay (ms) before processing member events to allow batching */
const MEMBER_EVENT_DEBOUNCE_MS = 5000;

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
 * Video message input. `isVideoNote` marks a Telegram round "video message"
 * (`video_note`) sent through this same path -- it has no caption or
 * `media_group_id` on the wire, but is otherwise a video.
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
  isVideoNote?: boolean;
  thumbnail?: {
    fileId: string;
    fileUniqueId: string;
    width?: number;
    height?: number;
  };
}

/**
 * Voice note input (Telegram `voice`) -- a short, usually-OGG/Opus recording.
 * Capture-only: nothing transcribes it (provenance-integrity-plan.md #5.1).
 */
export interface VoiceMessageInput extends BaseMessageInput {
  type: 'voice';
  caption?: string;
  fileId: string;
  fileUniqueId: string;
  duration?: number;
  mimeType?: string;
  fileSize?: number;
}

/**
 * Audio file input (Telegram `audio`) -- a music/audio file, distinct from a
 * `voice` note. Capture-only, same as voice.
 */
export interface AudioMessageInput extends BaseMessageInput {
  type: 'audio';
  caption?: string;
  fileId: string;
  fileUniqueId: string;
  duration?: number;
  performer?: string;
  title?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
}

/**
 * Union type for all media message inputs.
 */
export type MediaMessageInput =
  | PhotoMessageInput
  | DocumentMessageInput
  | VideoMessageInput
  | VoiceMessageInput
  | AudioMessageInput;

/**
 * An edited message input. Telegram reuses the original message's id, so the
 * caller must mint a distinct `externalEventId` for the edit (the original
 * event is never mutated -- it is an immutable ledger). `editOfExternalId` is
 * the original message's external id, for traceability.
 */
export interface EditMessageInput extends BaseMessageInput {
  type: 'edit';
  text: string;
  editOfExternalId: string;
}

/**
 * Member event input (join/leave).
 */
export interface MemberEventInput extends BaseMessageInput {
  type: 'join' | 'leave';
  /** The new status of the member (e.g., 'member', 'left', 'kicked') */
  memberStatus: string;
  /** The old status of the member before the change */
  oldMemberStatus?: string;
}

/**
 * Options for `MessageIngester`. `dbClient` is always required (`ensureIdentity`
 * upserts `family_access` directly against it); each repository can be
 * overridden independently for testing, defaulting to one built from
 * `dbClient` otherwise -- same convention as the agent classes
 * (`FollowupAgent`, `FacilitatorAgent`, ...).
 */
export interface MessageIngesterOptions {
  dbClient: DatabaseClient;
  logger?: pino.Logger;
  conversationEvents?: ConversationEventRepository;
  queueRepo?: ProcessingQueueRepository;
  eventLog?: EventLogRepository;
  identityRepo?: IdentityRepository;
}

/**
 * Platform-agnostic message ingester.
 * Handles deduplication, event creation, and queue enqueue.
 */
export class MessageIngester {
  private client: DatabaseClient;
  private conversationEvents: ConversationEventRepository;
  private queueRepo: ProcessingQueueRepository;
  private eventLog: EventLogRepository;
  private identityRepo: IdentityRepository;
  private logger: pino.Logger;

  constructor(options: MessageIngesterOptions) {
    this.client = options.dbClient;
    this.conversationEvents =
      options.conversationEvents ??
      new ConversationEventRepository(options.dbClient);
    this.queueRepo =
      options.queueRepo ?? new ProcessingQueueRepository(options.dbClient);
    this.eventLog =
      options.eventLog ?? new EventLogRepository(options.dbClient);
    this.identityRepo =
      options.identityRepo ?? new IdentityRepository(options.dbClient);
    this.logger = options.logger || createLogger({ name: 'ingester' });
  }

  /**
   * Ensure a global identity exists for the actor and family_access record exists.
   *
   * The unified identity model:
   * - identities: Global provider accounts (e.g., Telegram user 12345)
   * - family_access: Per-family permissions with status='pending' for chat participants
   */
  private async ensureIdentity(
    familyId: string,
    source: ChatProvider,
    actor: ActorInfo,
  ): Promise<void> {
    try {
      // Find or create global identity (no familyId needed)
      const { identity } = await this.identityRepo.findOrCreate(
        source,
        actor.externalId,
        actor.username,
        actor.displayName,
      );

      // Ensure family_access record exists with status='pending'
      // This marks the user as a chat participant (not yet web-authenticated)
      await this.client.from('family_access').upsert(
        {
          identity_id: identity.id,
          family_id: familyId,
          role: 'member',
          status: 'pending',
          granted_by: 'chat_join',
        },
        { onConflict: 'identity_id,family_id' },
      );
    } catch (err) {
      // Non-fatal: log but don't fail message ingestion
      this.logger.warn(
        { err, actor: actor.externalId },
        'Failed to create/update identity',
      );
    }
  }

  /**
   * Enqueue an event for processing and log the ingestion.
   */
  private async enqueue(
    familyId: string,
    eventId: string,
    actor: ActorInfo,
    messageType: string,
    eventData: Record<string, unknown>,
    options: EnqueueOptions = { priority: Priorities.USER_MESSAGE },
  ): Promise<void> {
    await this.queueRepo.enqueue(familyId, eventId, options);

    await this.eventLog.log({
      familyId,
      eventType: 'event_ingested',
      eventCategory: 'user_action',
      actor: actor.username || actor.externalId,
      actorType: 'user',
      conversationEventId: eventId,
      eventData: { messageType, ...eventData },
    });
  }

  /**
   * Ingest a text message from any provider.
   * Returns the event ID if created, null if duplicate.
   */
  async ingestTextMessage(
    familyId: string,
    input: TextMessageInput,
  ): Promise<string | null> {
    this.logger.debug(
      {
        conversationId: input.conversationId,
        eventId: input.externalEventId,
        from: input.actor.username,
      },
      'Ingesting text message',
    );

    // Ensure identity exists for the actor
    await this.ensureIdentity(familyId, input.source, input.actor);

    // Check for duplicates
    const existing = await this.conversationEvents.findByExternalId(
      familyId,
      input.source,
      input.conversationId,
      input.externalEventId,
    );

    if (existing) {
      this.logger.debug(
        { eventId: input.externalEventId },
        'Message already exists, skipping',
      );
      return null;
    }

    // Create conversation event
    const event = await this.conversationEvents.insert({
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
      occurredAt: input.occurredAt,
      ingestedAt: new Date(),
    });

    await this.enqueue(familyId, event.id, input.actor, 'text', {
      textLength: input.text.length,
      language: detectLanguage(input.text),
    });

    return event.id;
  }

  /**
   * Ingest a photo message from any provider.
   * Returns the event ID if created, null if duplicate.
   */
  async ingestPhotoMessage(
    familyId: string,
    input: PhotoMessageInput,
  ): Promise<string | null> {
    this.logger.debug(
      { conversationId: input.conversationId, eventId: input.externalEventId },
      'Ingesting photo message',
    );

    // Ensure identity exists for the actor
    await this.ensureIdentity(familyId, input.source, input.actor);

    // Check for duplicates
    const existing = await this.conversationEvents.findByExternalId(
      familyId,
      input.source,
      input.conversationId,
      input.externalEventId,
    );

    if (existing) {
      this.logger.debug(
        { eventId: input.externalEventId },
        'Photo already exists, skipping',
      );
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
    const event = await this.conversationEvents.insert({
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
      languageOriginal: input.caption
        ? detectLanguage(input.caption)
        : undefined,
      metadata,
      sourcePayload: input.sourcePayload,
      occurredAt: input.occurredAt,
      ingestedAt: new Date(),
    });

    await this.enqueue(familyId, event.id, input.actor, 'photo', {
      hasCaption: !!input.caption,
      photoSize: input.fileSize,
    });

    this.logger.info(
      { eventId: event.id, externalEventId: input.externalEventId },
      'Photo message ingested and queued',
    );

    return event.id;
  }

  /**
   * Ingest a document message from any provider.
   * Returns the event ID if created, null if duplicate.
   */
  async ingestDocumentMessage(
    familyId: string,
    input: DocumentMessageInput,
  ): Promise<string | null> {
    this.logger.debug(
      { conversationId: input.conversationId, eventId: input.externalEventId },
      'Ingesting document message',
    );

    // Ensure identity exists for the actor
    await this.ensureIdentity(familyId, input.source, input.actor);

    // Check for duplicates
    const existing = await this.conversationEvents.findByExternalId(
      familyId,
      input.source,
      input.conversationId,
      input.externalEventId,
    );

    if (existing) {
      this.logger.debug(
        { eventId: input.externalEventId },
        'Document already exists, skipping',
      );
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
    const event = await this.conversationEvents.insert({
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
      languageOriginal: input.caption
        ? detectLanguage(input.caption)
        : undefined,
      metadata,
      sourcePayload: input.sourcePayload,
      occurredAt: input.occurredAt,
      ingestedAt: new Date(),
    });

    await this.enqueue(familyId, event.id, input.actor, 'document', {
      hasCaption: !!input.caption,
      mimeType: input.mimeType,
      fileName: input.fileName,
    });

    this.logger.info(
      { eventId: event.id, externalEventId: input.externalEventId },
      'Document message ingested and queued',
    );

    return event.id;
  }

  /**
   * Ingest a video message from any provider.
   * Returns the event ID if created, null if duplicate.
   */
  async ingestVideoMessage(
    familyId: string,
    input: VideoMessageInput,
  ): Promise<string | null> {
    this.logger.debug(
      { conversationId: input.conversationId, eventId: input.externalEventId },
      'Ingesting video message',
    );

    // Ensure identity exists for the actor
    await this.ensureIdentity(familyId, input.source, input.actor);

    // Check for duplicates
    const existing = await this.conversationEvents.findByExternalId(
      familyId,
      input.source,
      input.conversationId,
      input.externalEventId,
    );

    if (existing) {
      this.logger.debug(
        { eventId: input.externalEventId },
        'Video already exists, skipping',
      );
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
      isVideoNote: input.isVideoNote || undefined,
    };

    // Create conversation event
    const event = await this.conversationEvents.insert({
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
      languageOriginal: input.caption
        ? detectLanguage(input.caption)
        : undefined,
      metadata,
      sourcePayload: input.sourcePayload,
      occurredAt: input.occurredAt,
      ingestedAt: new Date(),
    });

    await this.enqueue(familyId, event.id, input.actor, 'video', {
      hasCaption: !!input.caption,
      duration: input.duration,
      mimeType: input.mimeType,
    });

    this.logger.info(
      { eventId: event.id, externalEventId: input.externalEventId },
      'Video message ingested and queued',
    );

    return event.id;
  }

  /**
   * Ingest a voice note from any provider. Capture-only: nothing transcribes
   * it, so `contentOriginal` stays unset and the event carries no text for
   * the pipeline to extract from (provenance-integrity-plan.md #5.1).
   * Returns the event ID if created, null if duplicate.
   */
  async ingestVoiceMessage(
    familyId: string,
    input: VoiceMessageInput,
  ): Promise<string | null> {
    this.logger.debug(
      { conversationId: input.conversationId, eventId: input.externalEventId },
      'Ingesting voice message',
    );

    await this.ensureIdentity(familyId, input.source, input.actor);

    const existing = await this.conversationEvents.findByExternalId(
      familyId,
      input.source,
      input.conversationId,
      input.externalEventId,
    );

    if (existing) {
      this.logger.debug(
        { eventId: input.externalEventId },
        'Voice message already exists, skipping',
      );
      return null;
    }

    const metadata: Record<string, unknown> = {
      ...input.metadata,
      fileId: input.fileId,
      fileUniqueId: input.fileUniqueId,
      duration: input.duration,
      mimeType: input.mimeType,
      fileSize: input.fileSize,
    };

    const event = await this.conversationEvents.insert({
      familyId,
      source: input.source,
      conversationId: input.conversationId,
      externalEventId: input.externalEventId,
      externalReplyToId: input.externalReplyToId,
      actorExternalId: input.actor.externalId,
      actorDisplayName: input.actor.displayName,
      actorUsername: input.actor.username,
      eventType: 'voice',
      contentOriginal: input.caption || undefined,
      languageOriginal: input.caption
        ? detectLanguage(input.caption)
        : undefined,
      metadata,
      sourcePayload: input.sourcePayload,
      occurredAt: input.occurredAt,
      ingestedAt: new Date(),
    });

    await this.enqueue(familyId, event.id, input.actor, 'voice', {
      hasCaption: !!input.caption,
      duration: input.duration,
    });

    this.logger.info(
      { eventId: event.id, externalEventId: input.externalEventId },
      'Voice message ingested and queued',
    );

    return event.id;
  }

  /**
   * Ingest an audio file from any provider. Capture-only, same as voice.
   * Returns the event ID if created, null if duplicate.
   */
  async ingestAudioMessage(
    familyId: string,
    input: AudioMessageInput,
  ): Promise<string | null> {
    this.logger.debug(
      { conversationId: input.conversationId, eventId: input.externalEventId },
      'Ingesting audio message',
    );

    await this.ensureIdentity(familyId, input.source, input.actor);

    const existing = await this.conversationEvents.findByExternalId(
      familyId,
      input.source,
      input.conversationId,
      input.externalEventId,
    );

    if (existing) {
      this.logger.debug(
        { eventId: input.externalEventId },
        'Audio message already exists, skipping',
      );
      return null;
    }

    const metadata: Record<string, unknown> = {
      ...input.metadata,
      fileId: input.fileId,
      fileUniqueId: input.fileUniqueId,
      duration: input.duration,
      performer: input.performer,
      title: input.title,
      fileName: input.fileName,
      mimeType: input.mimeType,
      fileSize: input.fileSize,
    };

    const event = await this.conversationEvents.insert({
      familyId,
      source: input.source,
      conversationId: input.conversationId,
      externalEventId: input.externalEventId,
      externalReplyToId: input.externalReplyToId,
      actorExternalId: input.actor.externalId,
      actorDisplayName: input.actor.displayName,
      actorUsername: input.actor.username,
      eventType: 'audio',
      contentOriginal: input.caption || undefined,
      languageOriginal: input.caption
        ? detectLanguage(input.caption)
        : undefined,
      metadata,
      sourcePayload: input.sourcePayload,
      occurredAt: input.occurredAt,
      ingestedAt: new Date(),
    });

    await this.enqueue(familyId, event.id, input.actor, 'audio', {
      hasCaption: !!input.caption,
      duration: input.duration,
    });

    this.logger.info(
      { eventId: event.id, externalEventId: input.externalEventId },
      'Audio message ingested and queued',
    );

    return event.id;
  }

  /**
   * Ingest an edited message as a new, separate immutable event -- the
   * original event is never mutated. `input.externalEventId` must already be
   * distinct from the original message's id (the caller mints it); dedup
   * here only guards against re-delivery of the same edit.
   * Returns the event ID if created, null if duplicate.
   */
  async ingestEditMessage(
    familyId: string,
    input: EditMessageInput,
  ): Promise<string | null> {
    this.logger.debug(
      {
        conversationId: input.conversationId,
        eventId: input.externalEventId,
        editOf: input.editOfExternalId,
      },
      'Ingesting edited message',
    );

    await this.ensureIdentity(familyId, input.source, input.actor);

    const existing = await this.conversationEvents.findByExternalId(
      familyId,
      input.source,
      input.conversationId,
      input.externalEventId,
    );

    if (existing) {
      this.logger.debug(
        { eventId: input.externalEventId },
        'Edit already exists, skipping',
      );
      return null;
    }

    const metadata: Record<string, unknown> = {
      ...input.metadata,
      editOfExternalId: input.editOfExternalId,
    };

    const event = await this.conversationEvents.insert({
      familyId,
      source: input.source,
      conversationId: input.conversationId,
      externalEventId: input.externalEventId,
      externalReplyToId: input.externalReplyToId,
      actorExternalId: input.actor.externalId,
      actorDisplayName: input.actor.displayName,
      actorUsername: input.actor.username,
      eventType: 'edit',
      contentOriginal: input.text,
      languageOriginal: detectLanguage(input.text),
      metadata,
      sourcePayload: input.sourcePayload,
      occurredAt: input.occurredAt,
      ingestedAt: new Date(),
    });

    await this.enqueue(familyId, event.id, input.actor, 'edit', {
      textLength: input.text.length,
      editOfExternalId: input.editOfExternalId,
    });

    this.logger.info(
      {
        eventId: event.id,
        externalEventId: input.externalEventId,
        editOf: input.editOfExternalId,
      },
      'Edited message ingested and queued',
    );

    return event.id;
  }

  /**
   * Ingest a member event (join/leave) from any provider.
   * Returns the event ID if created, null if duplicate.
   */
  async ingestMemberEvent(
    familyId: string,
    input: MemberEventInput,
  ): Promise<string | null> {
    this.logger.debug(
      {
        conversationId: input.conversationId,
        eventId: input.externalEventId,
        eventType: input.type,
        memberStatus: input.memberStatus,
      },
      'Ingesting member event',
    );

    // Ensure identity exists for the actor
    await this.ensureIdentity(familyId, input.source, input.actor);

    // Check for duplicates
    const existing = await this.conversationEvents.findByExternalId(
      familyId,
      input.source,
      input.conversationId,
      input.externalEventId,
    );

    if (existing) {
      this.logger.debug(
        { eventId: input.externalEventId },
        'Member event already exists, skipping',
      );
      return null;
    }

    // Build metadata
    const metadata: Record<string, unknown> = {
      ...input.metadata,
      memberStatus: input.memberStatus,
      oldMemberStatus: input.oldMemberStatus,
    };

    // Create conversation event
    const event = await this.conversationEvents.insert({
      familyId,
      source: input.source,
      conversationId: input.conversationId,
      externalEventId: input.externalEventId,
      actorExternalId: input.actor.externalId,
      actorDisplayName: input.actor.displayName,
      actorUsername: input.actor.username,
      eventType: input.type,
      metadata,
      sourcePayload: input.sourcePayload,
      occurredAt: input.occurredAt,
      ingestedAt: new Date(),
    });

    // Enqueue with debounce delay (allows batching multiple joins)
    await this.enqueue(
      familyId,
      event.id,
      input.actor,
      input.type,
      { memberStatus: input.memberStatus },
      {
        priority: Priorities.MEMBER_EVENT,
        processAfter: new Date(Date.now() + MEMBER_EVENT_DEBOUNCE_MS),
      },
    );

    this.logger.info(
      { eventId: event.id, externalEventId: input.externalEventId },
      'Member event ingested and queued',
    );

    return event.id;
  }
}
