import type { Telegraf, Context } from 'telegraf';
import { createLogger } from '@sobremesa/shared-utils';
import { FamilyRepository } from '@sobremesa/database';
import type pino from 'pino';
import type { BotHandler, BotRole } from './types.js';

/**
 * Admin bot handler.
 *
 * Handles:
 * - Family registration (/register command)
 * - Welcoming new members
 * - Celebrating milestones
 * - Mediating conflicts
 * - Responding to direct messages
 */
export class AdminBotHandler implements BotHandler {
  readonly role: BotRole = 'admin';

  private logger: pino.Logger;
  private familyRepo: FamilyRepository;

  constructor(logger?: pino.Logger) {
    this.logger = logger || createLogger({ name: 'admin-bot' });
    this.familyRepo = new FamilyRepository();
  }

  configure(bot: Telegraf): void {
    // Handle /register command
    bot.command('register', async (ctx) => {
      await this.handleRegister(ctx);
    });

    // Handle /start command (in groups, acts like register)
    bot.command('start', async (ctx) => {
      if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
        await this.handleRegister(ctx);
      } else if (ctx.chat.type === 'private') {
        await ctx.reply(
          'Welcome to Sobremesa! Add me to your family group chat and use /register to set up your family archive.'
        );
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
   * Handle the /register command to create or link a family.
   */
  private async handleRegister(ctx: Context): Promise<void> {
    const chatId = String(ctx.chat?.id);
    const chatType = ctx.chat?.type;

    // Only allow in groups
    if (chatType !== 'group' && chatType !== 'supergroup') {
      await ctx.reply('Please use /register in a group chat, not in a private message.');
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
    const messageText = 'text' in (ctx.message || {}) ? (ctx.message as { text: string }).text : '';
    const args = messageText.replace(/^\/register\s*/, '').trim();
    const chatTitle = 'title' in (ctx.chat || {}) ? (ctx.chat as { title: string }).title : undefined;
    const familyName = args || chatTitle || 'My Family';

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

      // Check for other bots and guide user
      await this.checkAndPromptForMissingBots(ctx);
    } catch (error) {
      this.logger.error({ error, chatId }, 'Failed to register family');
      await ctx.reply(
        'Sorry, something went wrong while setting up your family archive. Please try again.'
      );
    }
  }

  /**
   * Check if the other Sobremesa bots are in the group and prompt user to add missing ones.
   */
  private async checkAndPromptForMissingBots(ctx: Context): Promise<void> {
    if (!ctx.chat) return;

    try {
      // Get all chat members who are admins (bots added to groups become members, not admins usually)
      // We need to check if the bots are in the chat - we can try to get their chat member status
      const missingBots: { name: string; username: string; description: string }[] = [];

      // Check for Scribe bot
      const scribePresent = await this.isBotInChat(ctx, 'sobremesa_scribe_bot');
      if (!scribePresent) {
        missingBots.push({
          name: 'Scribe',
          username: 'sobremesa_scribe_bot',
          description: 'Listens to messages and extracts stories',
        });
      }

      // Check for Facilitator bot
      const facilitatorPresent = await this.isBotInChat(ctx, 'sobremesa_facilitator_bot');
      if (!facilitatorPresent) {
        missingBots.push({
          name: 'Facilitator',
          username: 'sobremesa_facilitator_bot',
          description: 'Asks follow-up questions to gather more details',
        });
      }

      if (missingBots.length === 0) {
        await ctx.reply(
          "All Sobremesa bots are present! You're all set.\n\n" +
          "Just start chatting - share memories, stories, and photos. We'll preserve them all."
        );
        return;
      }

      // Build inline keyboard with deep links to add missing bots
      const keyboard = missingBots.map((bot) => [{
        text: `Add ${bot.name} Bot`,
        url: `https://t.me/${bot.username}?startgroup=true&admin=post_messages`,
      }]);

      await ctx.reply(
        `To complete setup, please add the following bot${missingBots.length > 1 ? 's' : ''}:\n\n` +
        missingBots.map((bot) => `• @${bot.username} - ${bot.description}`).join('\n') +
        '\n\nTap the buttons below to add each bot:',
        {
          reply_markup: {
            inline_keyboard: keyboard,
          },
        }
      );

      // If Scribe is missing, add a note about Privacy Mode
      if (missingBots.some((b) => b.username === 'sobremesa_scribe_bot')) {
        await ctx.reply(
          "Important: After adding the Scribe bot, you'll need to disable its Privacy Mode " +
          "so it can see all messages (not just commands).\n\n" +
          "To do this:\n" +
          "1. Message @BotFather\n" +
          "2. Send /mybots\n" +
          "3. Select @sobremesa_scribe_bot\n" +
          "4. Bot Settings → Group Privacy → Turn off"
        );
      }
    } catch (error) {
      this.logger.error({ error }, 'Failed to check for missing bots');
      // Don't fail registration if this check fails - just provide manual instructions
      await ctx.reply(
        "Next steps:\n" +
        "1. Add @sobremesa_scribe_bot to this group\n" +
        "2. Add @sobremesa_facilitator_bot to this group\n\n" +
        "Once all bots are added, just start chatting!"
      );
    }
  }

  /**
   * Check if a bot is present in the chat.
   */
  private async isBotInChat(ctx: Context, botUsername: string): Promise<boolean> {
    if (!ctx.chat) return false;

    try {
      // Try to get the bot's info first to get its ID
      // We can't directly query by username, so we attempt to get chat member
      // This will throw if the bot is not in the chat
      const botInfo = await ctx.telegram.getChat(`@${botUsername}`);
      if ('id' in botInfo) {
        const member = await ctx.telegram.getChatMember(ctx.chat.id, botInfo.id);
        return member.status !== 'left' && member.status !== 'kicked';
      }
      return false;
    } catch {
      // Bot not found or not in chat
      return false;
    }
  }
}
