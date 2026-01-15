import type { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import type { Message, Update, User } from 'telegraf/types';
import { createLogger } from '@sobremesa/shared-utils';
import { FamilyRepository, AllowedChatRepository } from '@sobremesa/database';
import type pino from 'pino';
import { BotRole, type BotHandler } from './types';
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
  msg: Message.TextMessage & { from: User },
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
  msg: Message.PhotoMessage & { from: User },
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
  msg: Message.DocumentMessage & { from: User },
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
 * Unified chatbot handler.
 *
 * Thin ingestion layer that:
 * - Handles /sobremesa command directly (creates families - can't queue without familyId)
 * - Enqueues all other messages for processing by Intern → Admin/Scribe pipeline
 *
 * No business logic except family registration bootstrap.
 */
export class ChatbotHandler implements BotHandler {
  readonly role = BotRole.CHATBOT;

  private familyRepo: FamilyRepository;
  private allowedChatRepo: AllowedChatRepository;
  private ingester: MessageIngester;
  private logger: pino.Logger;

  constructor(logger?: pino.Logger) {
    this.familyRepo = new FamilyRepository();
    this.allowedChatRepo = new AllowedChatRepository();
    this.logger = logger || createLogger({ name: 'chatbot' });
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
    // Handle /sobremesa command - bootstrap registration (can't queue without familyId)
    bot.command('sobremesa', async (ctx) => {
      try {
        await this.handleSobremesaCommand(ctx);
      } catch (error) {
        this.logger.error({ error }, 'Failed to handle /sobremesa command');
      }
    });

    // Handle text messages - enqueue for processing
    bot.on(message('text'), async (ctx) => {
      try {
        await this.handleTextMessage(ctx);
      } catch (error) {
        this.logger.error(
          { error, messageId: ctx.message.message_id },
          'Failed to ingest text message',
        );
      }
    });

    // Handle photos - enqueue for processing
    bot.on(message('photo'), async (ctx) => {
      try {
        await this.handlePhotoMessage(ctx);
      } catch (error) {
        this.logger.error(
          { error, messageId: ctx.message.message_id },
          'Failed to ingest photo message',
        );
      }
    });

    // Handle documents - enqueue for processing
    bot.on(message('document'), async (ctx) => {
      try {
        await this.handleDocumentMessage(ctx);
      } catch (error) {
        this.logger.error(
          { error, messageId: ctx.message.message_id },
          'Failed to ingest document message',
        );
      }
    });

    // Handle new chat members - enqueue for processing
    bot.on('chat_member', async (ctx) => {
      try {
        await this.handleChatMemberEvent(ctx);
      } catch (error) {
        this.logger.error({ error }, 'Failed to handle chat_member event');
      }
    });

    this.logger.info('Chatbot handlers configured');
  }

  /**
   * Handle /sobremesa command - family registration bootstrap.
   * This is handled directly because we need to create the family before we can queue.
   */
  private async handleSobremesaCommand(ctx: Context): Promise<void> {
    const chatId = String(ctx.chat?.id);
    const chatType = ctx.chat?.type;

    // Private chat - show help
    if (chatType === 'private') {
      await ctx.reply(
        'Welcome to Sobremesa! Add me to your family group chat and use /sobremesa to set up your family archive.',
      );
      return;
    }

    // Only allow in groups
    if (chatType !== 'group' && chatType !== 'supergroup') {
      return;
    }

    // Check if already registered
    const existingFamily = await this.familyRepo.findByChatId(chatId);
    if (existingFamily) {
      // Already registered - enqueue as text message so Intern can route to Admin for status
      // The message will be processed and Admin will show status
      const msg = ctx.message as Message.TextMessage & { from: User };
      if (msg.from) {
        const input = transformTextMessage(msg);
        await this.ingester.ingestTextMessage(existingFamily.id, input);
        this.logger.info(
          { chatId, familyId: existingFamily.id },
          '/sobremesa in registered chat - enqueued for processing',
        );
      }
      return;
    }

    // Not registered - check whitelist and create family
    const isAllowed = await this.allowedChatRepo.isAllowed(chatId);
    if (!isAllowed) {
      this.logger.warn(
        { chatId },
        'Registration attempted from non-whitelisted chat',
      );
      await ctx.reply(
        'This chat is not authorized to use Sobremesa. ' +
          'Please contact the administrator to whitelist this chat.',
      );
      return;
    }

    // Extract family name from command arguments or chat title
    const messageText =
      'text' in (ctx.message || {})
        ? (ctx.message as { text: string }).text
        : '';
    const args = messageText.replace(/^\/sobremesa(@\w+)?\s*/, '').trim();
    const chatTitle =
      'title' in (ctx.chat || {})
        ? (ctx.chat as { title: string }).title
        : undefined;
    const familyName = args || chatTitle || 'My Family';

    try {
      // Create the family
      const family = await this.familyRepo.createWithChat(familyName, chatId);

      this.logger.info(
        { familyId: family.id, familyName: family.name, chatId },
        'Family registered',
      );

      await ctx.reply(
        `Welcome to Sobremesa! I've set up "${family.name}" as your family archive.\n\n` +
          `Just start chatting - I'll preserve your family stories!\n\n` +
          `Important: Make sure Privacy Mode is disabled for this bot:\n` +
          `• Message @BotFather\n` +
          `• Send /mybots\n` +
          `• Select this bot\n` +
          `• Bot Settings → Group Privacy → Turn off`,
      );
    } catch (error) {
      this.logger.error({ error, chatId }, 'Failed to register family');
      await ctx.reply(
        'Sorry, something went wrong while setting up your family archive. Please try again.',
      );
    }
  }

  /**
   * Handle a text message - enqueue for processing.
   */
  private async handleTextMessage(ctx: TextMessageContext): Promise<void> {
    const msg = ctx.message;
    const chatId = String(msg.chat.id);

    // Skip if this is a command (handled separately)
    if (msg.text.startsWith('/')) {
      return;
    }

    // Look up family for this chat
    const familyId = await this.getFamilyIdForChat(chatId);
    if (!familyId) {
      this.logger.debug(
        { chatId, messageId: msg.message_id },
        'Chat not registered, ignoring message',
      );
      return;
    }

    const input = transformTextMessage(msg);
    const eventId = await this.ingester.ingestTextMessage(familyId, input);

    if (eventId) {
      this.logger.info(
        { eventId, messageId: msg.message_id, familyId },
        'Text message ingested and queued',
      );
    }
  }

  /**
   * Handle a photo message - enqueue for processing.
   */
  private async handlePhotoMessage(ctx: PhotoMessageContext): Promise<void> {
    const msg = ctx.message;
    const chatId = String(msg.chat.id);

    // Look up family for this chat
    const familyId = await this.getFamilyIdForChat(chatId);
    if (!familyId) {
      this.logger.debug(
        { chatId, messageId: msg.message_id },
        'Chat not registered, ignoring photo',
      );
      return;
    }

    const input = transformPhotoMessage(msg);
    const eventId = await this.ingester.ingestPhotoMessage(familyId, input);

    if (eventId) {
      this.logger.info(
        { eventId, messageId: msg.message_id, familyId },
        'Photo message ingested and queued',
      );
    }
  }

  /**
   * Handle a document message - enqueue for processing.
   */
  private async handleDocumentMessage(
    ctx: DocumentMessageContext,
  ): Promise<void> {
    const msg = ctx.message;
    const chatId = String(msg.chat.id);

    // Look up family for this chat
    const familyId = await this.getFamilyIdForChat(chatId);
    if (!familyId) {
      this.logger.debug(
        { chatId, messageId: msg.message_id },
        'Chat not registered, ignoring document',
      );
      return;
    }

    const input = transformDocumentMessage(msg);
    const eventId = await this.ingester.ingestDocumentMessage(familyId, input);

    if (eventId) {
      this.logger.info(
        { eventId, messageId: msg.message_id, familyId },
        'Document message ingested and queued',
      );
    }
  }

  /**
   * Handle chat member events - enqueue for processing.
   */
  private async handleChatMemberEvent(
    ctx: Context<Update.ChatMemberUpdate>,
  ): Promise<void> {
    const chatId = String(ctx.chat?.id);

    // Look up family for this chat
    const familyId = await this.getFamilyIdForChat(chatId);
    if (!familyId) {
      this.logger.debug(
        { chatId },
        'Chat not registered, ignoring chat_member event',
      );
      return;
    }

    // For now, just log the event
    // TODO: Create a conversation event for member changes so Intern can route to Admin
    const newMember = ctx.chatMember.new_chat_member;
    this.logger.info(
      {
        familyId,
        chatId,
        userId: newMember.user.id,
        username: newMember.user.username,
        status: newMember.status,
      },
      'Chat member event received',
    );
  }
}
