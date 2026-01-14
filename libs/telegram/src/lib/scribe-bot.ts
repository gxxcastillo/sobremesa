import type { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import type { Message, Update, User } from 'telegraf/types';
import { createLogger } from '@sobremesa/shared-utils';
import { FamilyRepository } from '@sobremesa/database';
import type pino from 'pino';
import type { BotHandler, BotRole } from './types';
import {
  MessageIngester,
  type TextMessageInput,
  type PhotoMessageInput,
  type DocumentMessageInput,
} from '@sobremesa/ingester';

type TextMessageContext = Context<Update.MessageUpdate<Message.TextMessage>>;
type PhotoMessageContext = Context<Update.MessageUpdate<Message.PhotoMessage>>;
type DocumentMessageContext = Context<
  Update.MessageUpdate<Message.DocumentMessage>
>;

/**
 * Get display name from Telegram user.
 */
function getDisplayName(user: {
  first_name: string;
  last_name?: string;
}): string {
  if (user.last_name) {
    return `${user.first_name} ${user.last_name}`;
  }
  return user.first_name;
}

/**
 * Transform a Telegram text message to generic input.
 */
function transformTextMessage(
  msg: Message.TextMessage & { from: User }
): TextMessageInput {
  return {
    type: 'text',
    source: 'telegram',
    conversationId: String(msg.chat.id),
    externalEventId: String(msg.message_id),
    externalReplyToId: msg.reply_to_message
      ? String(msg.reply_to_message.message_id)
      : undefined,
    actor: {
      externalId: String(msg.from.id),
      displayName: getDisplayName(msg.from),
      username: msg.from.username,
    },
    text: msg.text,
    occurredAt: new Date(msg.date * 1000),
    metadata: {
      chatType: msg.chat.type,
      chatTitle: 'title' in msg.chat ? msg.chat.title : undefined,
      forwardFrom: msg.forward_origin ? true : undefined,
    },
    sourcePayload: msg as unknown as Record<string, unknown>,
  };
}

/**
 * Transform a Telegram photo message to generic input.
 */
function transformPhotoMessage(
  msg: Message.PhotoMessage & { from: User }
): PhotoMessageInput {
  const photo = msg.photo[msg.photo.length - 1]; // Get largest photo
  return {
    type: 'photo',
    source: 'telegram',
    conversationId: String(msg.chat.id),
    externalEventId: String(msg.message_id),
    externalReplyToId: msg.reply_to_message
      ? String(msg.reply_to_message.message_id)
      : undefined,
    actor: {
      externalId: String(msg.from.id),
      displayName: getDisplayName(msg.from),
      username: msg.from.username,
    },
    caption: msg.caption,
    fileId: photo.file_id,
    fileUniqueId: photo.file_unique_id,
    width: photo.width,
    height: photo.height,
    fileSize: photo.file_size,
    occurredAt: new Date(msg.date * 1000),
    metadata: {
      chatType: msg.chat.type,
    },
    sourcePayload: msg as unknown as Record<string, unknown>,
  };
}

/**
 * Transform a Telegram document message to generic input.
 */
function transformDocumentMessage(
  msg: Message.DocumentMessage & { from: User }
): DocumentMessageInput {
  const doc = msg.document;
  return {
    type: 'document',
    source: 'telegram',
    conversationId: String(msg.chat.id),
    externalEventId: String(msg.message_id),
    externalReplyToId: msg.reply_to_message
      ? String(msg.reply_to_message.message_id)
      : undefined,
    actor: {
      externalId: String(msg.from.id),
      displayName: getDisplayName(msg.from),
      username: msg.from.username,
    },
    caption: msg.caption,
    fileId: doc.file_id,
    fileUniqueId: doc.file_unique_id,
    fileName: doc.file_name,
    mimeType: doc.mime_type,
    fileSize: doc.file_size,
    occurredAt: new Date(msg.date * 1000),
    metadata: {
      chatType: msg.chat.type,
    },
    sourcePayload: msg as unknown as Record<string, unknown>,
  };
}

/**
 * Scribe bot handler.
 *
 * Listens to all messages and ingests them for processing.
 * Looks up family by Telegram chat ID dynamically.
 * Occasionally posts acknowledgments or clarification questions.
 */
export class ScribeBotHandler implements BotHandler {
  readonly role: BotRole = 'scribe';

  private familyRepo: FamilyRepository;
  private ingester: MessageIngester;
  private logger: pino.Logger;

  constructor(logger?: pino.Logger) {
    this.familyRepo = new FamilyRepository();
    this.logger = logger || createLogger({ name: 'scribe-bot' });
    this.ingester = new MessageIngester(this.logger);
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
        await this.handleTextMessage(ctx);
      } catch (error) {
        this.logger.error(
          { error, messageId: ctx.message.message_id },
          'Failed to ingest text message'
        );
      }
    });

    // Handle photos
    bot.on(message('photo'), async (ctx) => {
      try {
        await this.handlePhotoMessage(ctx);
      } catch (error) {
        this.logger.error(
          { error, messageId: ctx.message.message_id },
          'Failed to ingest photo message'
        );
      }
    });

    // Handle documents
    bot.on(message('document'), async (ctx) => {
      try {
        await this.handleDocumentMessage(ctx);
      } catch (error) {
        this.logger.error(
          { error, messageId: ctx.message.message_id },
          'Failed to ingest document message'
        );
      }
    });

    this.logger.info('Scribe bot handlers configured');
  }

  /**
   * Handle a text message from Telegram.
   */
  private async handleTextMessage(ctx: TextMessageContext): Promise<void> {
    const msg = ctx.message;
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

    const input = transformTextMessage(msg);
    const eventId = await this.ingester.ingestTextMessage(familyId, input);

    if (eventId) {
      this.logger.info(
        { eventId, messageId: msg.message_id, familyId },
        'Text message ingested and queued'
      );
    }
  }

  /**
   * Handle a photo message from Telegram.
   */
  private async handlePhotoMessage(ctx: PhotoMessageContext): Promise<void> {
    const msg = ctx.message;
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

    const input = transformPhotoMessage(msg);
    const eventId = await this.ingester.ingestPhotoMessage(familyId, input);

    if (eventId) {
      this.logger.info(
        { eventId, messageId: msg.message_id, familyId },
        'Photo message ingested and queued'
      );
    }
  }

  /**
   * Handle a document message from Telegram.
   */
  private async handleDocumentMessage(
    ctx: DocumentMessageContext
  ): Promise<void> {
    const msg = ctx.message;
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

    const input = transformDocumentMessage(msg);
    const eventId = await this.ingester.ingestDocumentMessage(familyId, input);

    if (eventId) {
      this.logger.info(
        { eventId, messageId: msg.message_id, familyId },
        'Document message ingested and queued'
      );
    }
  }
}
