import type { Telegraf } from 'telegraf';
import type pino from 'pino';
import { BotRole, type OutgoingMessage } from '@sobremesa/shared-types';

// Re-export from shared-types for consumers
export { BotRole, type OutgoingMessage };

/**
 * Configuration for a single bot.
 */
export interface BotConfig {
  /** Bot role identifier */
  role: BotRole;
  /** Telegram bot token */
  token: string;
  /** Logger instance */
  logger?: pino.Logger;
}

/**
 * Configuration for the BotManager (single bot mode).
 */
export interface BotManagerConfig {
  /** Bot token */
  token: string;
  /** Logger instance */
  logger?: pino.Logger;
}

/**
 * Interface for bot handlers.
 */
export interface BotHandler {
  /** Configure the bot with handlers */
  configure(bot: Telegraf): void;
  /** Get the bot role */
  readonly role: BotRole;
}
