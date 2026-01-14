import type { Telegraf } from 'telegraf';
import { createLogger } from '@sobremesa/shared-utils';
import type pino from 'pino';
import type { BotHandler, BotRole } from './types';

/**
 * Facilitator bot handler.
 *
 * Handles:
 * - Asking follow-up questions (from Scribe's question queue)
 * - Responding to direct messages
 */
export class FacilitatorBotHandler implements BotHandler {
  readonly role: BotRole = 'facilitator';

  private logger: pino.Logger;

  constructor(logger?: pino.Logger) {
    this.logger = logger || createLogger({ name: 'facilitator-bot' });
  }

  configure(bot: Telegraf): void {
    // Handle /start command in DMs
    bot.command('start', async (ctx) => {
      if (ctx.chat.type === 'private') {
        await ctx.reply(
          "Hi! I'm the Sobremesa Facilitator. I help gather more details about family stories.\n\n" +
            "If you have a private story to share, feel free to message me here and I'll make sure it gets added to your family archive."
        );
      }
    });

    // Handle direct messages to facilitator bot
    bot.on('message', async (ctx) => {
      // Only handle private chats (DMs)
      if (ctx.chat.type === 'private') {
        this.logger.info(
          { userId: ctx.from?.id, username: ctx.from?.username },
          'Received DM to facilitator bot'
        );
        // TODO: Handle facilitator DMs (private answers, sensitive stories)
      }
    });

    this.logger.info('Facilitator bot handlers configured');
  }
}
