import type {
  QueueItem,
  QueueOptions,
  ProcessingResult,
} from '@sobremesa/shared-types';
import { ProcessingQueueRepository } from '@sobremesa/database';
import { createLogger, type LoggerOptions } from '@sobremesa/shared-utils';
import type pino from 'pino';

/**
 * Message handler function type.
 */
export type MessageHandler = (
  eventId: string,
  familyId: string
) => Promise<ProcessingResult>;

/**
 * In-memory message queue for POC.
 * Uses database for persistence and ordering.
 */
export class MessageQueue {
  private repository: ProcessingQueueRepository;
  private logger: pino.Logger;
  private handler?: MessageHandler;
  private isRunning = false;
  private workerId: string;
  private options: QueueOptions;
  private pollIntervalMs: number;
  private pollTimeout?: ReturnType<typeof setTimeout>;

  constructor(options?: {
    repository?: ProcessingQueueRepository;
    workerId?: string;
    queueOptions?: Partial<QueueOptions>;
    pollIntervalMs?: number;
    loggerOptions?: LoggerOptions;
  }) {
    this.repository = options?.repository || new ProcessingQueueRepository();
    this.workerId = options?.workerId || `worker-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.options = {
      maxRetries: 3,
      retryDelayMs: 5000,
      lockTimeoutMs: 300000,
      batchSize: 10,
      ...options?.queueOptions,
    };
    this.pollIntervalMs = options?.pollIntervalMs || 1000;
    this.logger = createLogger(options?.loggerOptions || { name: 'queue' });
  }

  /**
   * Set the message handler.
   */
  setHandler(handler: MessageHandler): void {
    this.handler = handler;
  }

  /**
   * Enqueue a message for processing.
   */
  async enqueue(familyId: string, eventId: string): Promise<QueueItem> {
    this.logger.debug({ familyId, eventId }, 'Enqueueing message');
    return this.repository.enqueue(familyId, eventId);
  }

  /**
   * Start processing messages from all families.
   */
  async start(): Promise<void> {
    if (!this.handler) {
      throw new Error('No message handler set');
    }

    if (this.isRunning) {
      this.logger.warn('Queue is already running');
      return;
    }

    this.isRunning = true;
    this.logger.info({ workerId: this.workerId }, 'Starting queue processor');

    await this.poll();
  }

  /**
   * Stop processing messages.
   */
  stop(): void {
    this.isRunning = false;
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = undefined;
    }
    this.logger.info('Queue processor stopped');
  }

  /**
   * Process a single message synchronously from any family.
   */
  async processOne(): Promise<boolean> {
    if (!this.handler) {
      throw new Error('No message handler set');
    }

    const item = await this.repository.dequeueAny(
      this.workerId,
      this.options.lockTimeoutMs
    );

    if (!item) {
      return false;
    }

    const familyId = item.familyId;
    this.logger.debug({ itemId: item.id, eventId: item.conversationEventId, familyId }, 'Processing message');

    try {
      const result = await this.handler(item.conversationEventId, familyId);

      if (result.success) {
        await this.repository.complete(familyId, item.id);
        this.logger.debug(
          { itemId: item.id, duration: result.duration },
          'Message processed successfully'
        );
      } else {
        await this.repository.fail(
          familyId,
          item.id,
          result.error || 'Unknown error',
          this.options.maxRetries
        );
        this.logger.warn(
          { itemId: item.id, error: result.error },
          'Message processing failed'
        );
      }

      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.repository.fail(
        familyId,
        item.id,
        errorMessage,
        this.options.maxRetries
      );
      this.logger.error(
        { itemId: item.id, error: errorMessage },
        'Message processing threw exception'
      );
      return true;
    }
  }

  /**
   * Get queue statistics.
   */
  async getStats(familyId: string): Promise<{
    queued: number;
    processing: number;
    done: number;
    error: number;
  }> {
    return this.repository.getStats(familyId);
  }

  /**
   * Check if the queue is running.
   */
  get running(): boolean {
    return this.isRunning;
  }

  /**
   * Poll for messages from all families.
   */
  private async poll(): Promise<void> {
    if (!this.isRunning) return;

    try {
      const processed = await this.processOne();

      // If we processed something, poll immediately
      // Otherwise, wait for the poll interval
      const delay = processed ? 0 : this.pollIntervalMs;

      this.pollTimeout = setTimeout(() => this.poll(), delay);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error({ err: err.message, stack: err.stack }, 'Error in poll loop');
      this.pollTimeout = setTimeout(() => this.poll(), this.pollIntervalMs);
    }
  }
}
