import { Telegraf } from 'telegraf';
import { createLogger } from '@sobremesa/shared-utils';
import type pino from 'pino';
import type { BotManagerConfig, BotRole, OutgoingMessage } from './types';
import { ScribeBotHandler } from './scribe-bot';
import { AdminBotHandler } from './admin-bot';
import { FacilitatorBotHandler } from './facilitator-bot';

/**
 * Managed bot instance.
 */
interface ManagedBot {
  role: BotRole;
  bot: Telegraf;
  token: string;
}

/**
 * Manages multiple Telegram bots for Sobremesa.
 *
 * Provides:
 * - Centralized start/stop for all bots
 * - Ability to send messages via any bot
 * - Shared configuration and logging
 */
export class BotManager {
  private bots: Map<BotRole, ManagedBot> = new Map();
  private logger: pino.Logger;

  constructor(config: BotManagerConfig) {
    this.logger = config.logger || createLogger({ name: 'bot-manager' });

    // Initialize Scribe bot if token provided
    if (config.scribeToken) {
      this.initializeBot('scribe', config.scribeToken);
    }

    // Initialize Admin bot if token provided
    if (config.adminToken) {
      this.initializeBot('admin', config.adminToken);
    }

    // Initialize Facilitator bot if token provided
    if (config.facilitatorToken) {
      this.initializeBot('facilitator', config.facilitatorToken);
    }

    this.logger.info(
      { botCount: this.bots.size, roles: [...this.bots.keys()] },
      'BotManager initialized'
    );
  }

  /**
   * Initialize a single bot with its handler.
   */
  private initializeBot(role: BotRole, token: string): void {
    const bot = new Telegraf(token);

    // Add logging middleware
    bot.use(async (ctx, next) => {
      const start = Date.now();
      await next();
      const duration = Date.now() - start;
      this.logger.debug(
        {
          role,
          updateType: ctx.updateType,
          duration,
          from: ctx.from?.username || ctx.from?.id,
        },
        'Update processed'
      );
    });

    // Configure role-specific handler
    const handler = this.createHandler(role);
    handler.configure(bot);

    // Error handling
    bot.catch((err, ctx) => {
      this.logger.error(
        { role, error: err, updateType: ctx.updateType },
        'Bot error'
      );
    });

    this.bots.set(role, { role, bot, token });
    this.logger.info({ role }, 'Bot initialized');
  }

  /**
   * Create the appropriate handler for a bot role.
   */
  private createHandler(role: BotRole) {
    switch (role) {
      case 'scribe':
        return new ScribeBotHandler(this.logger);
      case 'admin':
        return new AdminBotHandler(this.logger);
      case 'facilitator':
        return new FacilitatorBotHandler(this.logger);
    }
  }

  /**
   * Start all configured bots.
   */
  async start(): Promise<void> {
    const startPromises: Promise<void>[] = [];

    for (const [role, managed] of this.bots) {
      startPromises.push(
        managed.bot.launch().then(() => {
          this.logger.info({ role }, 'Bot started');
        })
      );
    }

    await Promise.all(startPromises);
    this.logger.info({ botCount: this.bots.size }, 'All bots started');
  }

  /**
   * Stop all bots gracefully.
   */
  async stop(signal?: string): Promise<void> {
    this.logger.info({ signal }, 'Stopping all bots');

    for (const [role, managed] of this.bots) {
      managed.bot.stop(signal);
      this.logger.info({ role }, 'Bot stopped');
    }

    this.logger.info('All bots stopped');
  }

  /**
   * Result of sending a message.
   */
  /**
   * Send a message via a specific bot.
   * Returns the Telegram message_id of the sent message.
   */
  async sendMessage(role: BotRole, message: OutgoingMessage): Promise<number> {
    const managed = this.bots.get(role);
    if (!managed) {
      this.logger.error({ role }, 'Bot not configured, cannot send message');
      throw new Error(`Bot "${role}" is not configured`);
    }

    try {
      const result = await managed.bot.telegram.sendMessage(
        message.chatId,
        message.text,
        {
          parse_mode: message.parseMode,
          reply_parameters: message.replyToMessageId
            ? { message_id: message.replyToMessageId }
            : undefined,
        }
      );

      this.logger.info(
        {
          role,
          chatId: message.chatId,
          textLength: message.text.length,
          messageId: result.message_id,
        },
        'Message sent'
      );

      return result.message_id;
    } catch (error) {
      this.logger.error(
        { role, chatId: message.chatId, error },
        'Failed to send message'
      );
      throw error;
    }
  }

  /**
   * Get a specific bot's Telegraf instance.
   */
  getBot(role: BotRole): Telegraf | undefined {
    return this.bots.get(role)?.bot;
  }

  /**
   * Check if a bot is configured.
   */
  hasBot(role: BotRole): boolean {
    return this.bots.has(role);
  }

  /**
   * Get all configured bot roles.
   */
  getConfiguredRoles(): BotRole[] {
    return [...this.bots.keys()];
  }
}
