import type { QueuePriorityLevel } from './queue';

/**
 * Provenance + natural dedup key for a durable outbound send, checked
 * against the `outbound_messages` ledger (`UNIQUE (family_id, dedup_key)`)
 * before the send is attempted. See `outbound-send-reliability-plan.md`.
 */
export interface SendDedupOptions {
  familyId: string;
  /** Natural per-send key, e.g. `historian-answer:<conversationEventId>`. */
  key: string;
  /** Reactive provenance: the incoming message this send replies to. */
  conversationEventId?: string;
  /** Proactive provenance: the `questions` row this send delivers. */
  questionId?: string;
}

/**
 * Options for sending a message.
 */
export interface SendOptions {
  /** Message priority (default: NORMAL = 5) */
  priority?: QueuePriorityLevel;
  /**
   * Ledger this send against a dedup key before attempting delivery.
   * Omit for a send that isn't tracked (e.g. `ChatbotHandler`'s direct
   * replies) -- behaves exactly as an untracked send always has.
   */
  dedup?: SendDedupOptions;
}

/**
 * Outcome of a `MessageSender.sendMessage` call. A definitive delivery
 * failure (4xx) is thrown as `MessageDeliveryError` instead of returned --
 * see there.
 */
export type SendOutcome =
  | { status: 'sent'; messageId: number }
  | { status: 'duplicate'; messageId?: number }
  | { status: 'unconfirmed' };

/**
 * Thrown by `MessageSender.sendMessage` only for a definitive,
 * provably-not-delivered failure (Telegram 4xx). A 5xx or network/timeout
 * error is irreducibly ambiguous and is never thrown -- it comes back as
 * `{ status: 'unconfirmed' }` so a caller never resends into a possible
 * duplicate. See `outbound-send-reliability-plan.md`'s lost-over-duplicate
 * policy.
 */
export class MessageDeliveryError extends Error {
  readonly delivered = false as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'MessageDeliveryError';
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}
