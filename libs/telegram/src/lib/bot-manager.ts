import { Telegraf, TelegramError } from 'telegraf';
import { createLogger } from '@sobremesa/shared-utils';
import { OutboundMessageRepository } from '@sobremesa/database';
import type pino from 'pino';
import type {
  BotRole,
  BotManagerConfig,
  OutgoingMessage,
  MessageSpacingConfig,
} from './types';
import type {
  SendDedupOptions,
  SendOptions,
  SendOutcome,
} from '@sobremesa/shared-types';
import { MessageDeliveryError, QueuePriority } from '@sobremesa/shared-types';
import { ChatbotHandler } from './chatbot';

/** Queued message with priority */
interface QueuedMessage {
  role: BotRole;
  message: OutgoingMessage;
  priority: number;
  dedup?: SendDedupOptions;
  resolve: (outcome: SendOutcome) => void;
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
  private outboundMessageRepo: OutboundMessageRepository;

  constructor(config: BotManagerConfig) {
    this.logger = config.logger || createLogger({ name: 'bot-manager' });
    this.spacingConfig = {
      ...DEFAULT_SPACING,
      ...config.messageSpacing,
    };
    this.outboundMessageRepo =
      config.outboundMessageRepo ??
      new OutboundMessageRepository(config.dbClient);

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
   * Resolves with a `SendOutcome` -- 'sent', 'duplicate' (a prior claim on
   * `options.dedup.key` already delivered; not resent), or 'unconfirmed'
   * (an ambiguous 5xx/network outcome, also not resent). Throws only
   * `MessageDeliveryError` for a definitive, provably-not-delivered (4xx)
   * failure. See `outbound-send-reliability-plan.md`.
   *
   * @param role - Bot role for the message
   * @param message - The message to send
   * @param options - Send options including priority and an optional dedup key
   */
  async sendMessage(
    role: BotRole,
    message: OutgoingMessage,
    options?: SendOptions,
  ): Promise<SendOutcome> {
    const chatId = String(message.chatId);
    const priority = options?.priority ?? QueuePriority.NORMAL;

    // Create a promise that will resolve when this message is sent
    return new Promise((resolve, reject) => {
      // Add to queue for this chat
      const queue = this.messageQueues.get(chatId) || [];
      queue.push({
        role,
        message,
        priority,
        dedup: options?.dedup,
        resolve,
        reject,
      });

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
      while (true) {
        const queue = this.messageQueues.get(chatId);
        if (!queue || queue.length === 0) {
          break;
        }

        // Get the highest priority message
        const item = queue.shift();
        if (!item) {
          break;
        }

        try {
          const outcome = await this.deliver(chatId, item);
          item.resolve(outcome);
        } catch (error) {
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
   * Deliver one queued item.
   *
   * If `item.dedup` is set, claims its key in the outbound ledger *before*
   * spacing/sending: a prior 'sent' claim short-circuits to 'duplicate'
   * (no send), and a prior unresolved claim ('pending'/'unknown') resolves
   * as 'unconfirmed' (no send) -- per the lost-over-duplicate policy,
   * an outcome that isn't known yet is never resent. Only a fresh or
   * reclaimed-'failed' claim proceeds to the real Telegram call.
   *
   * Throws only `MessageDeliveryError` (Telegram 4xx -- provably not
   * delivered). A 5xx or network/timeout error is irreducibly ambiguous
   * and is returned as `{ status: 'unconfirmed' }` instead, logged at
   * ERROR, never thrown -- so callers never turn it into a resend.
   */
  private async deliver(
    chatId: string,
    item: QueuedMessage,
  ): Promise<SendOutcome> {
    let claimedId: string | undefined;

    if (item.dedup) {
      const claim = await this.outboundMessageRepo.claim({
        familyId: item.dedup.familyId,
        dedupKey: item.dedup.key,
        role: item.role,
        chatId,
        content: item.message.text,
        conversationEventId: item.dedup.conversationEventId,
        questionId: item.dedup.questionId,
      });

      if (claim.outcome === 'duplicate') {
        this.logger.info(
          { chatId, dedupKey: item.dedup.key },
          'Skipping send; outbound ledger already shows this delivered',
        );
        return {
          status: 'duplicate',
          messageId: claim.message.externalMessageId
            ? Number(claim.message.externalMessageId)
            : undefined,
        };
      }

      if (claim.outcome === 'ambiguous') {
        this.logger.error(
          { chatId, dedupKey: item.dedup.key },
          'A prior send outcome for this dedup key is unresolved; skipping to avoid a possible duplicate',
        );
        return { status: 'unconfirmed' };
      }

      claimedId = claim.message.id;
    }

    // Wait for spacing only once we're actually about to call Telegram --
    // a duplicate/ambiguous skip above never touches the API.
    await this.waitForSpacing(chatId);

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

      if (item.dedup && claimedId) {
        await this.outboundMessageRepo.confirmSent(
          item.dedup.familyId,
          claimedId,
          String(result.message_id),
        );
      }

      return { status: 'sent', messageId: result.message_id };
    } catch (error) {
      // Telegram 4xx (incl. 429) is provably not delivered; everything
      // else (5xx, network/timeout, a non-TelegramError throw) is
      // irreducibly ambiguous. telegraf's callApi is a single POST with no
      // retry, so this classification is exhaustive.
      const notDelivered =
        error instanceof TelegramError && error.code >= 400 && error.code < 500;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.logger.error(
        { chatId, error: errorMessage, notDelivered },
        'Failed to send message',
      );

      if (item.dedup && claimedId) {
        if (notDelivered) {
          await this.outboundMessageRepo.confirmFailed(
            item.dedup.familyId,
            claimedId,
            errorMessage,
          );
        } else {
          await this.outboundMessageRepo.confirmUnknown(
            item.dedup.familyId,
            claimedId,
            errorMessage,
          );
        }
      }

      if (notDelivered) {
        throw new MessageDeliveryError(errorMessage, { cause: error });
      }

      // Ambiguous: never resend automatically (lost-over-duplicate policy).
      return { status: 'unconfirmed' };
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
