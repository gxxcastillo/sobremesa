/**
 * Status of a durable outbound send ledger row. See
 * `outbound-send-reliability-plan.md` for the full design; summary:
 * 'pending' -> claimed, send in flight or about to be; 'sent' -> confirmed
 * delivered; 'failed' -> definitively not delivered (4xx); 'unknown' ->
 * ambiguous outcome (5xx/network) -- never resent, per the lost-over-
 * duplicate policy.
 */
export type OutboundMessageStatus = 'pending' | 'sent' | 'failed' | 'unknown';

/**
 * A row in the outbound send ledger (`outbound_messages`). Backend-only;
 * bot text deliberately never reaches `conversation_events`.
 */
export interface OutboundMessage {
  id: string;
  familyId: string;
  /** Natural per-send dedup key, e.g. `historian-answer:<conversationEventId>`. */
  dedupKey: string;
  /** What kind of send this is (historian-answer, admin, facilitator-question, ...). */
  role: string;
  chatId: string;
  /** Final rendered text, frozen at claim time. */
  content: string;
  status: OutboundMessageStatus;
  /** Stamped at claim time, not right before the Telegram API call. */
  sendAttemptedAt?: Date;
  externalMessageId?: string;
  /** Reactive provenance: the incoming message this replies to. */
  conversationEventId?: string;
  /** Proactive provenance: the `questions` row this send delivers. */
  questionId?: string;
  attempts: number;
  lastError?: string;
  createdAt: Date;
  sentAt?: Date;
}

export interface ClaimOutboundMessageParams {
  familyId: string;
  dedupKey: string;
  role: string;
  chatId: string;
  content: string;
  conversationEventId?: string;
  questionId?: string;
}

/**
 * Outcome of claiming a dedup key:
 * - 'claimed': fresh row, or a reclaimed previously-failed row -- proceed to send.
 * - 'duplicate': a prior claim already reached 'sent' -- do not send again.
 * - 'ambiguous': a prior claim exists with an unresolved outcome ('pending'
 *   or 'unknown') -- never resend a send whose result isn't known.
 */
export type ClaimOutboundMessageOutcome = 'claimed' | 'duplicate' | 'ambiguous';

export interface ClaimOutboundMessageResult {
  outcome: ClaimOutboundMessageOutcome;
  message: OutboundMessage;
}
