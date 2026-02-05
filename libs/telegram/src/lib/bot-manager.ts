import { Telegraf } from 'telegraf';
import { createLogger } from '@sobremesa/shared-utils';
import type pino from 'pino';
import type {
  BotRole,
  BotManagerConfig,
  OutgoingMessage,
  MessageSpacingConfig,
} from './types';
import type { SendOptions } from '@sobremesa/shared-types';
import { QueuePriority } from '@sobremesa/shared-types';
import { ChatbotHandler } from './chatbot';

/** Queued message with priority */
interface QueuedMessage {
  role: BotRole;
  message: OutgoingMessage;
  priority: number;
  resolve: (messageId: number) => void;
  reject: (error: Error) => void;
}

/** Default message spacing configuration */
const DEFAULT_SPACING: Required<MessageSpacingConfig> = {
  minSecondsBetweenMessages: 3,
};

/**
 * Manages the Sobremesa Telegram bot.
 *
 * Single bot architecture:
 * - One bot handles all messages
 * - ChatbotHandler ingests everything to queue
 * - Agents process from queue
 *
 * Outgoing messages:
 * - In-memory priority queue per chat
 * - User-triggered responses (priority 2) sent before bot-initiated (priority 7)
 * - Spacing enforced between messages to same chat
 */
export class BotManager {
  private bot: Telegraf;
  private logger: pino.Logger;
  private spacingConfig: Required<MessageSpacingConfig>;
  private lastSendTimes: Map<string, number> = new Map();
  private messageQueues: Map<string, QueuedMessage[]> = new Map();
  private processingChats: Set<string> = new Set();

  constructor(config: BotManagerConfig) {
    this.logger = config.logger || createLogger({ name: 'bot-manager' });
    this.spacingConfig = {
      ...DEFAULT_SPACING,
      ...config.messageSpacing,
    };

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
    const handler = new ChatbotHandler({
      dbClient: config.dbClient,
      studioUrl: config.studioUrl,
      logger: this.logger,
    });
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
   * Send a message through the priority queue.
   *
   * Messages are queued and sent in priority order (lower number = higher priority).
   * User-triggered responses (priority 2) are sent before bot-initiated messages (priority 7).
   *
   * @param role - Bot role for the message
   * @param message - The message to send
   * @param options - Send options including priority
   * @returns The Telegram message_id of the sent message
   */
  async sendMessage(
    role: BotRole,
    message: OutgoingMessage,
    options?: SendOptions,
  ): Promise<number> {
    const chatId = String(message.chatId);
    const priority = options?.priority ?? QueuePriority.NORMAL;

    // Create a promise that will resolve when this message is sent
    return new Promise((resolve, reject) => {
      // Add to queue for this chat
      const queue = this.messageQueues.get(chatId) || [];
      queue.push({ role, message, priority, resolve, reject });

      // Sort by priority (lower = higher priority)
      queue.sort((a, b) => a.priority - b.priority);
      this.messageQueues.set(chatId, queue);

      this.logger.debug(
        { chatId, priority, queueLength: queue.length },
        'Message enqueued',
      );

      // Start processing if not already processing this chat
      this.processQueue(chatId);
    });
  }

  /**
   * Process the message queue for a chat.
   * Sends messages in priority order with spacing between sends.
   */
  private async processQueue(chatId: string): Promise<void> {
    // Prevent concurrent processing of the same chat
    if (this.processingChats.has(chatId)) {
      return;
    }
    this.processingChats.add(chatId);

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const queue = this.messageQueues.get(chatId);
        if (!queue || queue.length === 0) {
          break;
        }

        // Get the highest priority message
        const item = queue.shift();

        // Wait for spacing if needed
        await this.waitForSpacing(chatId);
        if (!item) {
          return;
        }

        // Send the message
        try {
          // Build options object
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const sendOptions: any = {
            parse_mode: item.message.parseMode,
            reply_parameters: item.message.replyToMessageId
              ? { message_id: item.message.replyToMessageId }
              : undefined,
          };
          // Add reply_markup if present (cast to Telegraf type)
          if (item.message.replyMarkup) {
            sendOptions.reply_markup = item.message.replyMarkup;
          }
          const result = await this.bot.telegram.sendMessage(
            item.message.chatId,
            item.message.text,
            sendOptions,
          );

          this.lastSendTimes.set(chatId, Date.now());

          this.logger.info(
            {
              chatId,
              priority: item.priority,
              textLength: item.message.text.length,
              messageId: result.message_id,
            },
            'Message sent',
          );

          item.resolve(result.message_id);
        } catch (error) {
          this.logger.error(
            { chatId, error: error instanceof Error ? error.message : error },
            'Failed to send message',
          );
          item.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
    } finally {
      this.processingChats.delete(chatId);
      this.messageQueues.delete(chatId);
    }
  }

  /**
   * Wait for spacing delay if we sent a message to this chat recently.
   */
  private async waitForSpacing(chatId: string): Promise<void> {
    const lastSend = this.lastSendTimes.get(chatId);
    if (!lastSend) {
      return;
    }

    const minDelayMs = this.spacingConfig.minSecondsBetweenMessages * 1000;
    const elapsed = Date.now() - lastSend;
    const remaining = minDelayMs - elapsed;

    if (remaining > 0) {
      this.logger.debug({ chatId, waitMs: remaining }, 'Waiting for spacing');
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  }

  /**
   * Get the Telegraf instance.
   */
  getBot(): Telegraf {
    return this.bot;
  }
}
