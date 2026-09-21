/**
 * Status of a queue item.
 */
export type QueueItemStatus = 'queued' | 'processing' | 'done' | 'error';

/**
 * What a queued row is queued *for*: 'live' (the always-on production
 * poller, full stage set) or 'import' (a scoped drain owned by a Studio/CLI
 * import job, running the same full Intern->Scribe->Registrar stage set
 * directly against a bounded, known set of event ids). Distinguishing these
 * lets the live poller refuse to ever claim a row an import drain owns --
 * import deliberately never wires admin/historian/facilitatorNudge, so a
 * historical import must never be processed by the live pipeline instead.
 * See `dequeue_processing_queue_item`'s own `p_intent_filter` parameter.
 */
export type QueueIntent = 'live' | 'import';

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
  intent: QueueIntent;
  /**
   * Set only on a member-join row another join's consolidated welcome
   * absorbed: the triggering join event's id.
   */
  consolidatedIntoEventId?: string;
}

/**
 * Options for enqueueing items.
 */
export interface EnqueueOptions {
  /** Priority level (1=highest, 10=lowest, default=5) */
  priority?: QueuePriorityLevel;
  /** Delay processing until this time (for debouncing) */
  processAfter?: Date;
  /** What this row is queued for. Default: 'live'. */
  intent?: QueueIntent;
}

/**
 * Options for queue operations.
 */
export interface QueueOptions {
  maxRetries: number;
  retryDelayMs: number;
  lockTimeoutMs: number;
  /**
   * Restrict dequeue to rows whose intent is in this list. Default:
   * undefined (no restriction -- matches every intent, today's behavior).
   * The always-on live poller (`apps/chatbots`) sets this explicitly to
   * `['live']` so it can never claim an 'import'-owned row.
   */
  intentFilter?: QueueIntent[];
}

/**
 * Default queue options.
 */
export const DEFAULT_QUEUE_OPTIONS: QueueOptions = {
  maxRetries: 3,
  retryDelayMs: 5000,
  lockTimeoutMs: 300000, // 5 minutes
};

/**
 * Result of processing a queue item.
 */
export interface ProcessingResult {
  success: boolean;
  error?: string;
  duration: number;
}
