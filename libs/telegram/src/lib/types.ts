import type { Telegraf } from 'telegraf';
import type pino from 'pino';

/**
 * Bot role identifier.
 */
export type BotRole = 'scribe' | 'admin' | 'facilitator';

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
 * Configuration for the BotManager.
 * Note: Family ID is looked up dynamically by chat ID, not configured here.
 */
export interface BotManagerConfig {
  /** Scribe bot token */
  scribeToken?: string;
  /** Admin bot token */
  adminToken?: string;
  /** Facilitator bot token */
  facilitatorToken?: string;
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

/**
 * Message to send via a bot.
 */
export interface OutgoingMessage {
  /** Chat ID to send to */
  chatId: string | number;
  /** Message text */
  text: string;
  /** Parse mode (optional) */
  parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2';
  /** Reply to message ID (optional) */
  replyToMessageId?: number;
}
