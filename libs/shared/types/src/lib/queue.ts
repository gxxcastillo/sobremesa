/**
 * Status of a queue item.
 */
export type QueueItemStatus = 'queued' | 'processing' | 'done' | 'error';

/**
 * Queue priority levels.
 * Lower number = higher priority (processed first).
 */
export const QueuePriority = {
  /** Highest priority - process immediately */
  CRITICAL: 1,
  /** High priority */
  HIGH: 2,
  /** Default priority */
  NORMAL: 5,
  /** Low priority - can wait */
  LOW: 7,
} as const;

export type QueuePriorityLevel =
  (typeof QueuePriority)[keyof typeof QueuePriority];

/**
 * Semantic priorities for different event/message types.
 * Used for both incoming (processing queue) and outgoing (message queue).
 */
export const Priorities = {
  // Incoming events (processing queue)
  /** User messages - highest priority, process immediately */
  USER_MESSAGE: QueuePriority.CRITICAL,
  /** Member join/leave events */
  MEMBER_EVENT: QueuePriority.NORMAL,

  // Outgoing messages (message queue)
  /** Responses to user commands (/status, /help) */
  USER_RESPONSE: QueuePriority.HIGH,
  /** Member event notifications (welcome, leave) */
  MEMBER_NOTIFICATION: QueuePriority.NORMAL,
  /** Bot-initiated questions - lowest priority */
  BOT_QUESTION: QueuePriority.LOW,
} as const;

/**
 * A processing queue item.
 */
export interface QueueItem {
  id: string;
  familyId: string;
  conversationEventId: string;
  queuedAt: Date;
  /** Item won't be dequeued until this time (for debouncing/delayed processing) */
  processAfter: Date;
  lockedAt?: Date;
  lockedBy?: string;
  status: QueueItemStatus;
  attempts: number;
  lastError?: string;
  priority: QueuePriorityLevel;
}

/**
 * Options for enqueueing items.
 */
export interface EnqueueOptions {
  /** Priority level (1=highest, 10=lowest, default=5) */
  priority?: QueuePriorityLevel;
  /** Delay processing until this time (for debouncing) */
  processAfter?: Date;
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
