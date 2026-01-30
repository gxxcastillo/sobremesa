import type { Telegraf } from 'telegraf';
import type pino from 'pino';
import type { BotRole, OutgoingMessage } from '@sobremesa/shared-types';
import type { DatabaseClient } from '@sobremesa/database';

// Re-export from shared-types for consumers
export type { BotRole, OutgoingMessage };

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
 * Configuration for message spacing.
 */
export interface MessageSpacingConfig {
  /** Minimum seconds between messages to the same chat (default: 3) */
  minSecondsBetweenMessages?: number;
}

/**
 * Configuration for the BotManager (single bot mode).
 */
export interface BotManagerConfig {
  /** Bot token */
  token: string;
  /** Database client */
  dbClient: DatabaseClient;
  /** Studio base URL for access pass links */
  studioUrl: string;
  /** Logger instance */
  logger?: pino.Logger;
  /** Message spacing configuration */
  messageSpacing?: MessageSpacingConfig;
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
