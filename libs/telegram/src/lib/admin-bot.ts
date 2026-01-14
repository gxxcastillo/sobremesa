import type { Telegraf, Context } from 'telegraf';
import { createLogger } from '@sobremesa/shared-utils';
import { FamilyRepository, AllowedChatRepository } from '@sobremesa/database';
import type pino from 'pino';
import type { BotHandler, BotRole } from './types';

/**
 * Admin bot handler.
 *
 * Handles:
 * - Family registration and setup (/sobremesa command)
 * - Welcoming new members
 * - Celebrating milestones
 * - Mediating conflicts
 * - Responding to direct messages
 */
export class AdminBotHandler implements BotHandler {
  readonly role: BotRole = 'admin';

  private logger: pino.Logger;
  private familyRepo: FamilyRepository;
  private allowedChatRepo: AllowedChatRepository;

  constructor(logger?: pino.Logger) {
    this.logger = logger || createLogger({ name: 'admin-bot' });
    this.familyRepo = new FamilyRepository();
    this.allowedChatRepo = new AllowedChatRepository();
  }

  configure(bot: Telegraf): void {
    // Handle /sobremesa command (initialize or show status)
    bot.command('sobremesa', async (ctx) => {
      if (ctx.chat.type === 'private') {
        // In private chat, show help
        await ctx.reply(
          'Welcome to Sobremesa! Add me to your family group chat and use /sobremesa to set up your family archive.'
        );
      } else if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
        // In group: check if family exists
        const chatId = String(ctx.chat.id);
        const family = await this.familyRepo.findByChatId(chatId);

        if (!family) {
          // Not registered yet - initialize
          await this.handleRegister(ctx);
        } else {
          // Already registered - show status
          await this.handleStatus(ctx);
        }
      }
    });

    // Handle new chat members
    bot.on('chat_member', async (ctx) => {
      if (ctx.chatMember.new_chat_member.status === 'member') {
        const user = ctx.chatMember.new_chat_member.user;
        this.logger.info(
          { userId: user.id, username: user.username },
          'New member joined - welcome message pending'
        );
        // TODO: Trigger AdminAgent to generate welcome message
      }
    });

    // Handle direct messages to admin bot
    bot.on('message', async (ctx) => {
      // Only handle private chats (DMs)
      if (ctx.chat.type === 'private') {
        this.logger.info(
          { userId: ctx.from?.id, username: ctx.from?.username },
          'Received DM to admin bot'
        );
        // TODO: Handle admin DMs (project questions, etc.)
      }
    });

    this.logger.info('Admin bot handlers configured');
  }

  /**
   * Handle the /status command to show setup verification.
   */
  private async handleStatus(ctx: Context): Promise<void> {
    const chatId = String(ctx.chat?.id);

    try {
      const family = await this.familyRepo.findByChatId(chatId);

      if (!family) {
        await ctx.reply(
          'No family is registered for this chat yet.\n\n' +
            'Use /sobremesa\\-init to set up your family archive.'
        );
        return;
      }

      await ctx.reply(
        `✅ **Family Setup Status**\n\n` +
          `**Family:** ${family.name}\n` +
          `**ID:** \`${family.id}\`\n` +
          `**Active:** ${family.isActive ? 'Yes' : 'No'}\n\n` +
          `**Verification Checklist:**\n\n` +
          `1️⃣ **Scribe Bot** (@sobremesa\\_scribe\\_bot)\n` +
          `   • Is it in this group? (should see it in members list)\n` +
          `   • Privacy Mode disabled? (required to see all messages)\n` +
          `   ➜ Test: Send a message here and check logs\n\n` +
          `2️⃣ **Facilitator Bot** (@sobremesa\\_facilitator\\_bot)\n` +
          `   • Is it in this group?\n` +
          `   ➜ Test: Send it a DM, it should respond\n\n` +
          `3️⃣ **Message Processing**\n` +
          `   ➜ Send a test message here and wait a few seconds\n` +
          `   ➜ Check logs to see if it was ingested\n\n` +
          `**Questions?** Review the setup instructions with /sobremesa`,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      this.logger.error({ error, chatId }, 'Failed to get status');
      await ctx.reply('Sorry, something went wrong while checking status.');
    }
  }

  /**
   * Handle the /start command to create or link a family.
   */
  private async handleRegister(ctx: Context): Promise<void> {
    const chatId = String(ctx.chat?.id);
    const chatType = ctx.chat?.type;

    // Only allow in groups
    if (chatType !== 'group' && chatType !== 'supergroup') {
      await ctx.reply(
        'Please use /sobremesa in a group chat, not in a private message.'
      );
      return;
    }

    // Check if chat is whitelisted
    const isAllowed = await this.allowedChatRepo.isAllowed(chatId);
    if (!isAllowed) {
      this.logger.warn(
        { chatId },
        'Registration attempted from non-whitelisted chat'
      );
      await ctx.reply(
        'This chat is not authorized to use Sobremesa. ' +
          'Please contact the administrator to whitelist this chat.'
      );
      return;
    }

    // Check if this chat is already registered
    const existingFamily = await this.familyRepo.findByChatId(chatId);
    if (existingFamily) {
      // Already registered - check if other bots are present
      await ctx.reply(
        `This group is already registered as "${existingFamily.name}".`
      );
      await this.checkAndPromptForMissingBots(ctx);
      return;
    }

    // Extract family name from command arguments or chat title
    const messageText =
      'text' in (ctx.message || {})
        ? (ctx.message as { text: string }).text
        : '';
    // Remove /sobremesa and optional @botname suffix
    const args = messageText.replace(/^\/sobremesa(@\w+)?\s*/, '').trim();
    const chatTitle =
      'title' in (ctx.chat || {})
        ? (ctx.chat as { title: string }).title
        : undefined;
    const familyName = args || chatTitle || 'My Family';

    this.logger.debug(
      { messageText, args, chatTitle, familyName },
      'Parsing family name'
    );

    try {
      // Create the family
      const family = await this.familyRepo.createWithChat(familyName, chatId);

      this.logger.info(
        { familyId: family.id, familyName: family.name, chatId },
        'Family registered'
      );

      await ctx.reply(
        `Welcome to Sobremesa! I've set up "${family.name}" as your family archive.`
      );

      // Provide setup instructions
      await this.checkAndPromptForMissingBots(ctx);
    } catch (error) {
      this.logger.error({ error, chatId }, 'Failed to register family');
      await ctx.reply(
        'Sorry, something went wrong while setting up your family archive. Please try again.'
      );
    }
  }

  /**
   * Check for other Sobremesa bots and provide setup instructions.
   */
  private async checkAndPromptForMissingBots(ctx: Context): Promise<void> {
    if (!ctx.chat) return;

    // For now, just provide instructions to add the other bots
    // Bot detection via API is unreliable, so we'll skip the check
    await ctx.reply(
      'Setup complete! Next steps:\n\n' +
        '1. Add @sobremesa_scribe_bot to this group (listens and extracts stories)\n' +
        '2. Add @sobremesa_facilitator_bot to this group (asks follow-up questions)\n\n' +
        'Important: For the Scribe bot to see all messages, disable its Privacy Mode:\n' +
        '• Message @BotFather\n' +
        '• Send /mybots\n' +
        '• Select @sobremesa_scribe_bot\n' +
        '• Bot Settings → Group Privacy → Turn off\n\n' +
        "Once all bots are added, just start chatting - we'll preserve your family stories!"
    );
  }
}
