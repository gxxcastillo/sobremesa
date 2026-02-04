import type { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import type { Message, Update, User } from 'telegraf/types';
import { createLogger } from '@sobremesa/shared-utils';
import {
  FamilyRepository,
  AllowedChatRepository,
  IdentityRepository,
  type DatabaseClient,
} from '@sobremesa/database';
import {
  createAccessPass,
  buildAccessPassUrl,
  determineRoleFromAdminStatus,
} from '@sobremesa/auth';
import type pino from 'pino';
import type { BotHandler } from './types';
import {
  MessageIngester,
  type TextMessageInput,
  type PhotoMessageInput,
  type DocumentMessageInput,
  type MemberEventInput,
} from '@sobremesa/ingester';
import { AdminSyncHandler } from './handlers/admin-sync';

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

// Supported language codes
const SUPPORTED_LANGUAGES = ['en', 'es', 'pt', 'fr', 'de'] as const;
type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number];

function isLanguageCode(value: string): value is LanguageCode {
  return SUPPORTED_LANGUAGES.includes(value as LanguageCode);
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
  readonly role = 'chatbot';

  private dbClient: DatabaseClient;
  private familyRepo: FamilyRepository;
  private allowedChatRepo: AllowedChatRepository;
  private ingester: MessageIngester;
  private adminSyncHandler: AdminSyncHandler;
  private logger: pino.Logger;
  private studioBaseUrl: string;

  constructor(options: {
    dbClient: DatabaseClient;
    studioUrl: string;
    logger?: pino.Logger;
  }) {
    this.dbClient = options.dbClient;
    this.studioBaseUrl = options.studioUrl;
    this.familyRepo = new FamilyRepository(this.dbClient);
    this.allowedChatRepo = new AllowedChatRepository(this.dbClient);
    this.logger = options.logger || createLogger({ name: 'chatbot' });
    this.ingester = new MessageIngester(this.dbClient, this.logger);
    this.adminSyncHandler = new AdminSyncHandler(this.dbClient, this.logger);
  }

  /**
   * Get family for a chat if registered and not paused.
   * Returns null if not registered or paused.
   */
  private async getActiveFamilyForChat(
    chatId: string,
  ): Promise<{ id: string } | null> {
    const family = await this.familyRepo.findByChatId(chatId);
    if (!family) return null;

    // Check if paused
    const config = (family.config || {}) as Record<string, unknown>;
    if (config.paused === true) {
      return null;
    }

    return { id: family.id };
  }

  configure(bot: Telegraf): void {
    // Handle /sobremesa command - bootstrap registration (can't queue without familyId)
    bot.command('sobremesa', async (ctx) => {
      try {
        await this.handleSobremesaCommand(ctx, bot);
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
          { err: error, messageId: ctx.message.message_id },
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
          { err: error, messageId: ctx.message.message_id },
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
          { err: error, messageId: ctx.message.message_id },
          'Failed to ingest document message',
        );
      }
    });

    // Handle new chat members - enqueue for processing
    bot.on('chat_member', async (ctx) => {
      try {
        await this.handleChatMemberEvent(ctx);
        // Also update admin status cache
        await this.adminSyncHandler.handleChatMemberUpdate(ctx);
      } catch (error) {
        this.logger.error({ error }, 'Failed to handle chat_member event');
      }
    });

    // Handle bot being added/removed from chats (sync admins when added)
    bot.on('my_chat_member', async (ctx) => {
      try {
        await this.adminSyncHandler.handleMyChatMemberUpdate(bot, ctx);
      } catch (error) {
        this.logger.error({ error }, 'Failed to handle my_chat_member event');
      }
    });

    this.logger.info('Chatbot handlers configured');
  }

  /**
   * Handle /sobremesa command - family registration bootstrap.
   * This is handled directly because we need to create the family before we can queue.
   */
  private async handleSobremesaCommand(
    ctx: Context,
    bot: Telegraf,
  ): Promise<void> {
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

    // Extract arguments from command
    const messageText =
      'text' in (ctx.message || {})
        ? (ctx.message as { text: string }).text
        : '';
    const args = messageText
      .replace(/^\/sobremesa(@\w+)?\s*/, '')
      .trim()
      .toLowerCase();

    // Check if already registered
    const existingFamily = await this.familyRepo.findByChatId(chatId);
    if (existingFamily) {
      // Admin-only subcommands require group admin status
      const adminOnlySubcommands = ['pause', 'stop', 'resume', 'start'];
      const isAdminSubcommand =
        adminOnlySubcommands.includes(args) || /^lang:\w+$/.test(args);

      if (isAdminSubcommand) {
        const adminUserId = ctx.from?.id;
        if (!adminUserId) {
          return;
        }

        const isAdmin = await this.adminSyncHandler.isUserAdmin(
          bot,
          chatId,
          existingFamily.id,
          adminUserId,
        );

        if (!isAdmin) {
          await ctx.reply(
            'Only group admins can change Sobremesa settings. ' +
              'Use /sobremesa help to see available commands.',
          );
          return;
        }
      }

      // Handle language code argument (e.g., /sobremesa lang:en, /sobremesa lang:es)
      const langMatch = args.match(/^lang:(\w+)$/);
      if (langMatch) {
        const langCode = langMatch[1];
        if (isLanguageCode(langCode)) {
          try {
            await this.familyRepo.updateConfigPath(
              existingFamily.id,
              ['languages', 'primary'],
              langCode,
            );
            const langNames: Record<LanguageCode, string> = {
              en: 'English',
              es: 'Español',
              pt: 'Português',
              fr: 'Français',
              de: 'Deutsch',
            };
            await ctx.reply(`Language set to ${langNames[langCode]}.`);
            this.logger.info(
              { familyId: existingFamily.id, language: langCode },
              'Language updated via /sobremesa command',
            );
          } catch (error) {
            this.logger.error({ error }, 'Failed to update language');
            await ctx.reply('Failed to update language. Please try again.');
          }
        } else {
          await ctx.reply(
            `Unknown language code: ${langCode}\n\n` +
              `Supported languages: ${SUPPORTED_LANGUAGES.join(', ')}`,
          );
        }
        return;
      }

      // Handle pause command
      if (args === 'pause' || args === 'stop') {
        try {
          const config = (existingFamily.config || {}) as Record<
            string,
            unknown
          >;
          const alreadyPaused = config.paused === true;

          if (alreadyPaused) {
            await ctx.reply(
              "Sobremesa is already paused. I'm not processing any messages right now.\n\n" +
                'Use /sobremesa resume when you want me to start listening again.',
            );
          } else {
            await this.familyRepo.updateConfigPath(
              existingFamily.id,
              ['paused'],
              true,
            );
            await ctx.reply(
              "Sobremesa is now paused. I'll stop processing messages until you resume.\n\n" +
                'Use /sobremesa resume when you want me to start listening again.',
            );
            this.logger.info({ familyId: existingFamily.id }, 'Family paused');
          }
        } catch (error) {
          this.logger.error({ error }, 'Failed to pause');
          await ctx.reply('Failed to pause. Please try again.');
        }
        return;
      }

      // Handle resume command
      if (args === 'resume' || args === 'start') {
        try {
          const config = (existingFamily.config || {}) as Record<
            string,
            unknown
          >;
          const wasPaused = config.paused === true;

          if (!wasPaused) {
            await ctx.reply(
              "Sobremesa is already running! I'm listening and preserving your family stories.",
            );
          } else {
            await this.familyRepo.updateConfigPath(
              existingFamily.id,
              ['paused'],
              false,
            );
            await ctx.reply(
              "Sobremesa is back! I'm now listening and preserving your family stories again.",
            );
            this.logger.info({ familyId: existingFamily.id }, 'Family resumed');
          }
        } catch (error) {
          this.logger.error({ error }, 'Failed to resume');
          await ctx.reply('Failed to resume. Please try again.');
        }
        return;
      }

      // Handle status command
      if (args === 'status') {
        const config = (existingFamily.config || {}) as Record<string, unknown>;
        const isPaused = config.paused === true;
        const languages = config.languages as
          | Record<string, unknown>
          | undefined;
        const primaryLang = languages?.primary as string | undefined;

        const langNames: Record<string, string> = {
          en: 'English',
          es: 'Español',
          pt: 'Português',
          fr: 'Français',
          de: 'Deutsch',
        };

        const statusEmoji = isPaused ? '⏸️' : '▶️';
        const statusText = isPaused ? 'Paused' : 'Running';
        const langDisplay = primaryLang
          ? langNames[primaryLang] || primaryLang
          : 'Not set';

        const createdDate = existingFamily.createdAt
          ? new Date(existingFamily.createdAt).toLocaleDateString()
          : 'Unknown';

        await ctx.reply(
          `📊 *Sobremesa Status*\n\n` +
            `${statusEmoji} *Status:* ${statusText}\n` +
            `👨‍👩‍👧‍👦 *Family:* ${existingFamily.name}\n` +
            `🌐 *Language:* ${langDisplay}\n` +
            `📅 *Created:* ${createdDate}`,
          { parse_mode: 'Markdown' },
        );
        return;
      }

      // Handle help command
      if (args === 'help') {
        const helpUserId = ctx.from?.id;
        const isAdmin = helpUserId
          ? await this.adminSyncHandler.isUserAdmin(
              bot,
              chatId,
              existingFamily.id,
              helpUserId,
            )
          : false;

        let helpText =
          `📖 *Sobremesa Commands*\n\n` +
          `*/sobremesa status* - Show current status\n` +
          `*/sobremesa studio-link* - Get a link to access Sobremesa Studio\n`;

        if (isAdmin) {
          helpText +=
            `*/sobremesa pause* - Pause message processing\n` +
            `*/sobremesa resume* - Resume message processing\n` +
            `*/sobremesa lang:en* - Set language to English\n` +
            `*/sobremesa lang:es* - Set language to Español\n` +
            `*/sobremesa lang:pt* - Set language to Português\n` +
            `*/sobremesa lang:fr* - Set language to Français\n` +
            `*/sobremesa lang:de* - Set language to Deutsch\n`;
        }

        helpText += `*/sobremesa help* - Show this help message`;

        await ctx.reply(helpText, { parse_mode: 'Markdown' });
        return;
      }

      // Handle studio-link command - generate access pass for Studio web app
      if (args === 'studio-link' || args === 'studio') {
        await this.handleStudioLinkCommand(ctx, bot, existingFamily.id, chatId);
        return;
      }

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

    // Not registered - check allowlist and create family
    const isAllowed = await this.allowedChatRepo.isAllowed(chatId);
    if (!isAllowed) {
      this.logger.warn(
        { chatId },
        'Registration attempted from unauthorized chat',
      );
      await ctx.reply(
        'This chat is not authorized to use Sobremesa. ' +
          'Please contact the administrator.',
      );
      return;
    }

    // Only group admins can register a new family
    const userId = ctx.from?.id;
    if (!userId) {
      return;
    }

    try {
      const member = await bot.telegram.getChatMember(chatId, userId);
      if (member.status !== 'administrator' && member.status !== 'creator') {
        await ctx.reply(
          'Only group admins can set up Sobremesa. ' +
            'Please ask a group admin to run /sobremesa.',
        );
        return;
      }
    } catch (error) {
      this.logger.error(
        { err: error, chatId, userId },
        'Failed to verify admin status for registration',
      );
      await ctx.reply('Could not verify your admin status. Please try again.');
      return;
    }

    // Extract family name from command arguments or chat title
    // (use original args without toLowerCase for family name)
    const originalArgs = messageText
      .replace(/^\/sobremesa(@\w+)?\s*/, '')
      .trim();
    const chatTitle =
      'title' in (ctx.chat || {})
        ? (ctx.chat as { title: string }).title
        : undefined;
    const familyName = originalArgs || chatTitle || 'My Family';

    try {
      // Create the family
      const family = await this.familyRepo.createWithChat(familyName, chatId);

      this.logger.info(
        { familyId: family.id, familyName: family.name, chatId },
        'Family registered',
      );

      // Sync admins and create identities for all chat admins
      await this.adminSyncHandler.syncChatAdmins(bot, chatId, family.id);

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
      this.logger.error({ err: error, chatId }, 'Failed to register family');
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

    // Look up active family for this chat (not registered or paused = null)
    const family = await this.getActiveFamilyForChat(chatId);
    if (!family) {
      this.logger.debug(
        { chatId, messageId: msg.message_id },
        'Chat not registered or paused, ignoring message',
      );
      return;
    }

    const input = transformTextMessage(msg);
    const eventId = await this.ingester.ingestTextMessage(family.id, input);

    if (eventId) {
      this.logger.info(
        { eventId, messageId: msg.message_id, familyId: family.id },
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

    // Look up active family for this chat (not registered or paused = null)
    const family = await this.getActiveFamilyForChat(chatId);
    if (!family) {
      this.logger.debug(
        { chatId, messageId: msg.message_id },
        'Chat not registered or paused, ignoring photo',
      );
      return;
    }

    const input = transformPhotoMessage(msg);
    const eventId = await this.ingester.ingestPhotoMessage(family.id, input);

    if (eventId) {
      this.logger.info(
        { eventId, messageId: msg.message_id, familyId: family.id },
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

    // Look up active family for this chat (not registered or paused = null)
    const family = await this.getActiveFamilyForChat(chatId);
    if (!family) {
      this.logger.debug(
        { chatId, messageId: msg.message_id },
        'Chat not registered or paused, ignoring document',
      );
      return;
    }

    const input = transformDocumentMessage(msg);
    const eventId = await this.ingester.ingestDocumentMessage(family.id, input);

    if (eventId) {
      this.logger.info(
        { eventId, messageId: msg.message_id, familyId: family.id },
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

    // Look up active family for this chat (not registered or paused = null)
    const family = await this.getActiveFamilyForChat(chatId);
    if (!family) {
      this.logger.debug(
        { chatId },
        'Chat not registered or paused, ignoring chat_member event',
      );
      return;
    }

    const oldMember = ctx.chatMember.old_chat_member;
    const newMember = ctx.chatMember.new_chat_member;

    // Determine if this is a join or leave event
    // Join: member was not in the chat (left, kicked, restricted) and now is (member, administrator, creator)
    // Leave: member was in the chat and now is not
    const wasInChat = ['member', 'administrator', 'creator'].includes(
      oldMember.status,
    );
    const isInChat = ['member', 'administrator', 'creator'].includes(
      newMember.status,
    );

    let eventType: 'join' | 'leave' | null = null;
    if (!wasInChat && isInChat) {
      eventType = 'join';
    } else if (wasInChat && !isInChat) {
      eventType = 'leave';
    }

    // Skip if this is not a join/leave transition (e.g., status change within members)
    if (!eventType) {
      this.logger.debug(
        {
          chatId,
          oldStatus: oldMember.status,
          newStatus: newMember.status,
        },
        'Chat member status change is not a join/leave event, ignoring',
      );
      return;
    }

    // Create a unique event ID for this member change
    const externalEventId = `member_${eventType}_${newMember.user.id}_${ctx.chatMember.date}`;

    const input: MemberEventInput = {
      type: eventType,
      source: 'telegram',
      conversationId: chatId,
      externalEventId,
      actor: {
        externalId: String(newMember.user.id),
        displayName: getDisplayName(newMember.user),
        username: newMember.user.username,
      },
      memberStatus: newMember.status,
      oldMemberStatus: oldMember.status,
      occurredAt: new Date(ctx.chatMember.date * 1000),
      metadata: {
        chatType: ctx.chat?.type,
      },
      sourcePayload: ctx.chatMember as unknown as Record<string, unknown>,
    };

    const eventId = await this.ingester.ingestMemberEvent(family.id, input);

    if (eventId) {
      this.logger.info(
        {
          eventId,
          familyId: family.id,
          chatId,
          userId: newMember.user.id,
          username: newMember.user.username,
          eventType,
        },
        'Member event ingested and queued',
      );
    }
  }

  /**
   * Handle /sobremesa studio-link command - generate access pass for Studio web app.
   */
  private async handleStudioLinkCommand(
    ctx: Context,
    bot: Telegraf,
    familyId: string,
    chatId: string,
  ): Promise<void> {
    const user = ctx.from;
    if (!user) {
      await ctx.reply('Could not identify user. Please try again.');
      return;
    }

    try {
      // Check if user is admin in this chat
      const isAdmin = await this.adminSyncHandler.isUserAdmin(
        bot,
        chatId,
        familyId,
        user.id,
      );

      // Determine role based on admin status
      const role = determineRoleFromAdminStatus(isAdmin);

      // Look up global identity for this user (may not exist if they've never messaged)
      const identityRepo = new IdentityRepository(this.dbClient);
      const identity = await identityRepo.findByProviderUserId(
        'telegram',
        String(user.id),
      );

      // Create access pass (no profile data stored - only lookup fields)
      const result = await createAccessPass(this.dbClient, {
        familyId,
        role,
        provider: 'telegram',
        providerUserId: String(user.id),
        identityId: identity?.id,
        chatId,
        expiresInHours: 24,
      });

      if (!result.success || !result.token) {
        this.logger.error(
          { userId: user.id, error: result.error },
          'Failed to create access pass',
        );
        await ctx.reply(
          "Sorry, I couldn't create an access pass. Please try again later.",
        );
        return;
      }

      // Build the access URL
      const accessUrl = buildAccessPassUrl(result.token, this.studioBaseUrl);

      // Send the link via DM
      try {
        const roleText = role === 'admin' ? 'admin' : 'member';
        const expiresText = result.expiresAt
          ? `This link expires in 24 hours.`
          : '';

        await bot.telegram.sendMessage(
          user.id,
          `🔑 *Sobremesa Studio Access Pass*\n\n` +
            `Click the link below to access your family's Studio dashboard:\n\n` +
            `${accessUrl}\n\n` +
            `You'll have *${roleText}* access to the family data.\n` +
            `${expiresText}`,
          { parse_mode: 'Markdown' },
        );

        // Confirm in the group
        await ctx.reply(
          `I've sent your Studio access link via DM, ${user.first_name}! ` +
            `Check your private messages from me.`,
        );

        this.logger.info(
          {
            userId: user.id,
            familyId,
            role,
            username: user.username,
          },
          'Studio access pass sent via DM',
        );
      } catch (dmError) {
        // User probably hasn't started a chat with the bot
        this.logger.warn(
          { userId: user.id, error: dmError },
          'Could not send DM - user may not have started chat with bot',
        );

        await ctx.reply(
          `${user.first_name}, I couldn't send you a DM. ` +
            `Please start a chat with me first:\n\n` +
            `1. Click on my name to open a chat\n` +
            `2. Press "Start"\n` +
            `3. Then come back here and run /sobremesa studio-link again`,
        );
      }
    } catch (error) {
      this.logger.error(
        { err: error, userId: user.id, familyId, chatId },
        'Error handling studio-link command',
      );
      await ctx.reply('Sorry, something went wrong. Please try again later.');
    }
  }
}
