import { Context } from 'telegraf';
import { Message, Update } from 'telegraf/types';
import { createLogger } from '@sobremesa/shared-utils';
import { detectLanguage } from '@sobremesa/shared-types';
import {
  ConversationEventRepository,
  ProcessingQueueRepository,
  EventLogRepository,
} from '@sobremesa/database';

const logger = createLogger({ name: 'ingester' });

type TextMessageContext = Context<Update.MessageUpdate<Message.TextMessage>>;
type PhotoMessageContext = Context<Update.MessageUpdate<Message.PhotoMessage>>;
type DocumentMessageContext = Context<Update.MessageUpdate<Message.DocumentMessage>>;

export class MessageIngester {
  private familyId: string;
  private eventRepo: ConversationEventRepository;
  private queueRepo: ProcessingQueueRepository;
  private eventLog: EventLogRepository;

  constructor(familyId: string) {
    this.familyId = familyId;
    this.eventRepo = new ConversationEventRepository();
    this.queueRepo = new ProcessingQueueRepository();
    this.eventLog = new EventLogRepository();
  }

  /**
   * Ingest a text message from Telegram.
   */
  async ingestTextMessage(ctx: TextMessageContext): Promise<void> {
    const msg = ctx.message;
    const text = msg.text;

    logger.debug(
      { chatId: msg.chat.id, messageId: msg.message_id, from: msg.from.username },
      'Ingesting text message'
    );

    // Check for duplicates
    const existing = await this.eventRepo.findByExternalId(
      this.familyId,
      'telegram',
      String(msg.chat.id),
      String(msg.message_id)
    );

    if (existing) {
      logger.debug({ messageId: msg.message_id }, 'Message already exists, skipping');
      return;
    }

    // Create conversation event
    const event = await this.eventRepo.insert({
      familyId: this.familyId,
      source: 'telegram',
      conversationId: String(msg.chat.id),
      externalEventId: String(msg.message_id),
      externalReplyToId: msg.reply_to_message
        ? String(msg.reply_to_message.message_id)
        : undefined,
      actorExternalId: String(msg.from.id),
      actorDisplayName: this.getDisplayName(msg.from),
      actorUsername: msg.from.username,
      eventType: 'message',
      contentOriginal: text,
      languageOriginal: detectLanguage(text),
      metadata: {
        chatType: msg.chat.type,
        chatTitle: 'title' in msg.chat ? msg.chat.title : undefined,
        forwardFrom: msg.forward_origin ? true : undefined,
      },
      sourcePayload: msg as unknown as Record<string, unknown>,
      processed: false,
      redacted: false,
      occurredAt: new Date(msg.date * 1000),
      ingestedAt: new Date(),
    });

    // Enqueue for processing
    await this.queueRepo.enqueue(this.familyId, event.id);

    // Log the event
    await this.eventLog.log({
      familyId: this.familyId,
      eventType: 'event_ingested',
      eventCategory: 'user_action',
      actor: msg.from.username || String(msg.from.id),
      actorType: 'user',
      sourceEventId: event.id,
      eventData: {
        messageType: 'text',
        textLength: text.length,
        language: detectLanguage(text),
      },
    });

    logger.info(
      { eventId: event.id, messageId: msg.message_id },
      'Text message ingested and queued'
    );
  }

  /**
   * Ingest a photo message from Telegram.
   */
  async ingestPhotoMessage(ctx: PhotoMessageContext): Promise<void> {
    const msg = ctx.message;
    const caption = msg.caption || '';
    const photo = msg.photo[msg.photo.length - 1]; // Get largest photo

    logger.debug(
      { chatId: msg.chat.id, messageId: msg.message_id },
      'Ingesting photo message'
    );

    // Check for duplicates
    const existing = await this.eventRepo.findByExternalId(
      this.familyId,
      'telegram',
      String(msg.chat.id),
      String(msg.message_id)
    );

    if (existing) {
      logger.debug({ messageId: msg.message_id }, 'Photo already exists, skipping');
      return;
    }

    // Create conversation event
    const event = await this.eventRepo.insert({
      familyId: this.familyId,
      source: 'telegram',
      conversationId: String(msg.chat.id),
      externalEventId: String(msg.message_id),
      externalReplyToId: msg.reply_to_message
        ? String(msg.reply_to_message.message_id)
        : undefined,
      actorExternalId: String(msg.from.id),
      actorDisplayName: this.getDisplayName(msg.from),
      actorUsername: msg.from.username,
      eventType: 'photo',
      contentOriginal: caption || undefined,
      languageOriginal: caption ? detectLanguage(caption) : undefined,
      metadata: {
        chatType: msg.chat.type,
        fileId: photo.file_id,
        fileUniqueId: photo.file_unique_id,
        width: photo.width,
        height: photo.height,
        fileSize: photo.file_size,
      },
      sourcePayload: msg as unknown as Record<string, unknown>,
      processed: false,
      redacted: false,
      occurredAt: new Date(msg.date * 1000),
      ingestedAt: new Date(),
    });

    // Enqueue for processing
    await this.queueRepo.enqueue(this.familyId, event.id);

    // Log the event
    await this.eventLog.log({
      familyId: this.familyId,
      eventType: 'event_ingested',
      eventCategory: 'user_action',
      actor: msg.from.username || String(msg.from.id),
      actorType: 'user',
      sourceEventId: event.id,
      eventData: {
        messageType: 'photo',
        hasCaption: !!caption,
        photoSize: photo.file_size,
      },
    });

    logger.info(
      { eventId: event.id, messageId: msg.message_id },
      'Photo message ingested and queued'
    );
  }

  /**
   * Ingest a document message from Telegram.
   */
  async ingestDocumentMessage(ctx: DocumentMessageContext): Promise<void> {
    const msg = ctx.message;
    const caption = msg.caption || '';
    const doc = msg.document;

    logger.debug(
      { chatId: msg.chat.id, messageId: msg.message_id },
      'Ingesting document message'
    );

    // Check for duplicates
    const existing = await this.eventRepo.findByExternalId(
      this.familyId,
      'telegram',
      String(msg.chat.id),
      String(msg.message_id)
    );

    if (existing) {
      logger.debug({ messageId: msg.message_id }, 'Document already exists, skipping');
      return;
    }

    // Create conversation event
    const event = await this.eventRepo.insert({
      familyId: this.familyId,
      source: 'telegram',
      conversationId: String(msg.chat.id),
      externalEventId: String(msg.message_id),
      externalReplyToId: msg.reply_to_message
        ? String(msg.reply_to_message.message_id)
        : undefined,
      actorExternalId: String(msg.from.id),
      actorDisplayName: this.getDisplayName(msg.from),
      actorUsername: msg.from.username,
      eventType: 'document',
      contentOriginal: caption || undefined,
      languageOriginal: caption ? detectLanguage(caption) : undefined,
      metadata: {
        chatType: msg.chat.type,
        fileId: doc.file_id,
        fileUniqueId: doc.file_unique_id,
        fileName: doc.file_name,
        mimeType: doc.mime_type,
        fileSize: doc.file_size,
      },
      sourcePayload: msg as unknown as Record<string, unknown>,
      processed: false,
      redacted: false,
      occurredAt: new Date(msg.date * 1000),
      ingestedAt: new Date(),
    });

    // Enqueue for processing
    await this.queueRepo.enqueue(this.familyId, event.id);

    // Log the event
    await this.eventLog.log({
      familyId: this.familyId,
      eventType: 'event_ingested',
      eventCategory: 'user_action',
      actor: msg.from.username || String(msg.from.id),
      actorType: 'user',
      sourceEventId: event.id,
      eventData: {
        messageType: 'document',
        hasCaption: !!caption,
        mimeType: doc.mime_type,
        fileName: doc.file_name,
      },
    });

    logger.info(
      { eventId: event.id, messageId: msg.message_id },
      'Document message ingested and queued'
    );
  }

  /**
   * Get display name from Telegram user.
   */
  private getDisplayName(user: { first_name: string; last_name?: string }): string {
    if (user.last_name) {
      return `${user.first_name} ${user.last_name}`;
    }
    return user.first_name;
  }
}
