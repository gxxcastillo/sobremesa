import type { QueuePriorityLevel } from './queue';

/**
 * Options for sending a message.
 */
export interface SendOptions {
  /** Message priority (default: NORMAL = 5) */
  priority?: QueuePriorityLevel;
}
