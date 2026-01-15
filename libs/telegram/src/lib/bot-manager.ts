import { Telegraf } from 'telegraf';
import { createLogger } from '@sobremesa/shared-utils';
import type pino from 'pino';
import type { BotRole, BotManagerConfig, OutgoingMessage } from './types';
import { ChatbotHandler } from './chatbot';

/**
 * Manages the Sobremesa Telegram bot.
 *
 * Single bot architecture:
 * - One bot handles all messages
 * - ChatbotHandler ingests everything to queue
 * - Agents process from queue
 */
export class BotManager {
  private bot: Telegraf;
  private logger: pino.Logger;

  constructor(config: BotManagerConfig) {
    this.logger = config.logger || createLogger({ name: 'bot-manager' });

    this.bot = new Telegraf(config.token);

    // Add logging middleware
    this.bot.use(async (ctx, next) => {
      const start = Date.now();
      await next();
      const duration = Date.now() - start;
      this.logger.debug(
        {
          updateType: ctx.updateType,
          duration,
          from: ctx.from?.username || ctx.from?.id,
        },
        'Update processed',
      );
    });

    // Configure chatbot handler
    const handler = new ChatbotHandler(this.logger);
    handler.configure(this.bot);

    // Error handling
    this.bot.catch((err, ctx) => {
      this.logger.error(
        { error: err, updateType: ctx.updateType },
        'Bot error',
      );
    });

    this.logger.info('BotManager initialized (single bot mode)');
  }

  /**
   * Start the bot.
   */
  async start(): Promise<void> {
    await this.bot.launch();
    this.logger.info('Bot started');
  }

  /**
   * Stop the bot gracefully.
   */
  async stop(signal?: string): Promise<void> {
    this.logger.info({ signal }, 'Stopping bot');
    this.bot.stop(signal);
    this.logger.info('Bot stopped');
  }

  /**
   * Send a message.
   *
   * @param role - Ignored in single-bot mode (kept for backwards compat)
   * @param message - The message to send
   * @returns The Telegram message_id of the sent message
   */
  async sendMessage(role: BotRole, message: OutgoingMessage): Promise<number> {
    try {
      const result = await this.bot.telegram.sendMessage(
        message.chatId,
        message.text,
        {
          parse_mode: message.parseMode,
          reply_parameters: message.replyToMessageId
            ? { message_id: message.replyToMessageId }
            : undefined,
        },
      );

      this.logger.info(
        {
          chatId: message.chatId,
          textLength: message.text.length,
          messageId: result.message_id,
        },
        'Message sent',
      );

      return result.message_id;
    } catch (error) {
      this.logger.error(
        { chatId: message.chatId, error },
        'Failed to send message',
      );
      throw error;
    }
  }

  /**
   * Get the Telegraf instance.
   */
  getBot(): Telegraf {
    return this.bot;
  }
}
