/**
 * Status of a queue item.
 */
export type QueueItemStatus = 'queued' | 'processing' | 'done' | 'error';

/**
 * A processing queue item.
 */
export interface QueueItem {
  id: string;
  familyId: string;
  conversationEventId: string;
  queuedAt: Date;
  lockedAt?: Date;
  lockedBy?: string;
  status: QueueItemStatus;
  attempts: number;
  lastError?: string;
}

/**
 * Options for queue operations.
 */
export interface QueueOptions {
  maxRetries: number;
  retryDelayMs: number;
  lockTimeoutMs: number;
  batchSize: number;
}

/**
 * Default queue options.
 */
export const DEFAULT_QUEUE_OPTIONS: QueueOptions = {
  maxRetries: 3,
  retryDelayMs: 5000,
  lockTimeoutMs: 300000, // 5 minutes
  batchSize: 10,
};

/**
 * Result of processing a queue item.
 */
export interface ProcessingResult {
  success: boolean;
  error?: string;
  duration: number;
}
