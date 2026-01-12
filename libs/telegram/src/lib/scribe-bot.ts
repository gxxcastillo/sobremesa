import type { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import type { Message, Update } from 'telegraf/types';
  import { createLogger } from '@sobremesa/shared-utils';
  import { detectLanguage } from '@sobremesa/shared-types';
  import {
    ConversationEventRepository,
    ProcessingQueueRepository,
    EventLogRepository,
    FamilyRepository,
  } from '@sobremesa/database';
  import type pino from 'pino';
  import type { BotHandler, BotRole } from './types.js';

  type TextMessageContext = Context<Update.MessageUpdate<Message.TextMessage>>;
  type PhotoMessageContext = Context<Update.MessageUpdate<Message.PhotoMessage>>;
  type DocumentMessageContext = Context<Update.MessageUpdate<Message.DocumentMessage>>;

/**
 * Scribe bot handler.
 *
 * Listens to all messages and ingests them for processing.
 * Looks up family by Telegram chat ID dynamically.
 * Occasionally posts acknowledgments or clarification questions.
 */
export class ScribeBotHandler implements BotHandler {
  readonly role: BotRole = 'scribe';

  private eventRepo: ConversationEventRepository;
  private queueRepo: ProcessingQueueRepository;
  private eventLog: EventLogRepository;
  private familyRepo: FamilyRepository;
  private logger: pino.Logger;

  constructor(logger?: pino.Logger) {
    this.eventRepo = new ConversationEventRepository();
    this.queueRepo = new ProcessingQueueRepository();
    this.eventLog = new EventLogRepository();
    this.familyRepo = new FamilyRepository();
    this.logger = logger || createLogger({ name: 'scribe-bot' });
  }

  /**
   * Get family ID for a chat, or null if not registered.
   */
  private async getFamilyIdForChat(chatId: string): Promise<string | null> {
    const family = await this.familyRepo.findByChatId(chatId);
    return family?.id || null;
  }

  configure(bot: Telegraf): void {
    // Handle text messages
    bot.on(message('text'), async (ctx) => {
      try {
        await this.ingestTextMessage(ctx);
      } catch (error) {
        this.logger.error({ error, messageId: ctx.message.message_id }, 'Failed to ingest text message');
      }
    });

    // Handle photos
    bot.on(message('photo'), async (ctx) => {
      try {
        await this.ingestPhotoMessage(ctx);
      } catch (error) {
        this.logger.error({ error, messageId: ctx.message.message_id }, 'Failed to ingest photo message');
      }
    });

    // Handle documents
    bot.on(message('document'), async (ctx) => {
      try {
        await this.ingestDocumentMessage(ctx);
      } catch (error) {
        this.logger.error({ error, messageId: ctx.message.message_id }, 'Failed to ingest document message');
      }
    });

    this.logger.info('Scribe bot handlers configured');
  }

  /**
   * Ingest a text message from Telegram.
   */
  private async ingestTextMessage(ctx: TextMessageContext): Promise<void> {
    const msg = ctx.message;
    const text = msg.text;
    const chatId = String(msg.chat.id);

    // Look up family for this chat
    const familyId = await this.getFamilyIdForChat(chatId);
    if (!familyId) {
      this.logger.debug(
        { chatId, messageId: msg.message_id },
        'Chat not registered, ignoring message'
      );
      return;
    }

    this.logger.debug(
      { chatId, messageId: msg.message_id, from: msg.from.username, familyId },
      'Ingesting text message'
    );

    // Check for duplicates
    const existing = await this.eventRepo.findByExternalId(
      familyId,
      'telegram',
      chatId,
      String(msg.message_id)
    );

    if (existing) {
      this.logger.debug({ messageId: msg.message_id }, 'Message already exists, skipping');
      return;
    }

    // Create conversation event
    const event = await this.eventRepo.insert({
      familyId,
      source: 'telegram',
      conversationId: chatId,
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
    await this.queueRepo.enqueue(familyId, event.id);

    // Log the event
    await this.eventLog.log({
      familyId,
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

    this.logger.info(
      { eventId: event.id, messageId: msg.message_id },
      'Text message ingested and queued'
    );
  }

  /**
   * Ingest a photo message from Telegram.
   */
  private async ingestPhotoMessage(ctx: PhotoMessageContext): Promise<void> {
    const msg = ctx.message;
    const caption = msg.caption || '';
    const photo = msg.photo[msg.photo.length - 1]; // Get largest photo
    const chatId = String(msg.chat.id);

    // Look up family for this chat
    const familyId = await this.getFamilyIdForChat(chatId);
    if (!familyId) {
      this.logger.debug(
        { chatId, messageId: msg.message_id },
        'Chat not registered, ignoring photo'
      );
      return;
    }

    this.logger.debug(
      { chatId, messageId: msg.message_id, familyId },
      'Ingesting photo message'
    );

    // Check for duplicates
    const existing = await this.eventRepo.findByExternalId(
      familyId,
      'telegram',
      chatId,
      String(msg.message_id)
    );

    if (existing) {
      this.logger.debug({ messageId: msg.message_id }, 'Photo already exists, skipping');
      return;
    }

    // Create conversation event
    const event = await this.eventRepo.insert({
      familyId,
      source: 'telegram',
      conversationId: chatId,
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
    await this.queueRepo.enqueue(familyId, event.id);

    // Log the event
    await this.eventLog.log({
      familyId,
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

    this.logger.info(
      { eventId: event.id, messageId: msg.message_id },
      'Photo message ingested and queued'
    );
  }

  /**
   * Ingest a document message from Telegram.
   */
  private async ingestDocumentMessage(ctx: DocumentMessageContext): Promise<void> {
    const msg = ctx.message;
    const caption = msg.caption || '';
    const doc = msg.document;
    const chatId = String(msg.chat.id);

    // Look up family for this chat
    const familyId = await this.getFamilyIdForChat(chatId);
    if (!familyId) {
      this.logger.debug(
        { chatId, messageId: msg.message_id },
        'Chat not registered, ignoring document'
      );
      return;
    }

    this.logger.debug(
      { chatId, messageId: msg.message_id, familyId },
      'Ingesting document message'
    );

    // Check for duplicates
    const existing = await this.eventRepo.findByExternalId(
      familyId,
      'telegram',
      chatId,
      String(msg.message_id)
    );

    if (existing) {
      this.logger.debug({ messageId: msg.message_id }, 'Document already exists, skipping');
      return;
    }

    // Create conversation event
    const event = await this.eventRepo.insert({
      familyId,
      source: 'telegram',
      conversationId: chatId,
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
    await this.queueRepo.enqueue(familyId, event.id);

    // Log the event
    await this.eventLog.log({
      familyId,
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

    this.logger.info(
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
