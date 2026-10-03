import type { LanguageCode } from './languages';

/**
 * Event types for the audit log.
 *
 * Event lifecycle:
 * - event_ingested: Raw message received from chat provider
 * - event_processed: Message processed by Scribe/Curator
 * - event_filtered: Message filtered out by Intern's standalone filter call
 *   (only used when a pipeline wires `filter` without `router` -- the
 *   ordinary case, `router` + `filter` together, logs `intern_evaluated`
 *   instead; see its own doc below)
 * - intern_evaluated: Intern's `route()` resolved for a conversation event --
 *   the canonical, append-only record of every routing decision (relevant/
 *   ignored, admin, or historian), for every ingress (live chat, Studio
 *   import, CLI import) alike. Not a review/workflow state -- it is written
 *   once per actual `route()` call and never read back as pipeline input.
 * - event_redacted: Event redacted for privacy
 * - event_unredacted: Event redaction reversed
 * - image_linked: Image linked to a conversation event
 * - claim_rejected: Registrar rejected a claim (e.g. context bleed)
 * - entity_enriched: Registrar changed fields on an existing entity (see
 *   `EntityEnrichedEventData`) -- the provenance trail for writes that have
 *   no backing claim
 *
 * Question lifecycle:
 * - question_proposed: Scribe proposes a follow-up question
 * - followup_evaluated: the story follow-up hook ended without proposing a
 *   question -- pacing skip, decline, guard, or failure (see
 *   `FollowupEvaluatedEventData`)
 * - question_asked: Facilitator asks a proactive question
 * - question_answered: Historian generates an answer to an @mention
 * - question_responded: Facilitator formats and sends the historian's answer
 * - question_retired: Question removed from queue (answered, stale, etc.)
 *
 * Moderation & coaching:
 * - conflict_detected: Conflicting claims detected in family data
 * - facilitator_decision: Facilitator decides to ask/wait
 * - celebration_sent: Celebration message sent to family
 * - mediation_sent: Mediation message sent for conflicts
 *
 * Configuration:
 * - rule_changed: Family rule/setting changed
 * - lever_changed: Real-time lever adjusted
 *
 * Import:
 * - import_started: WhatsApp/chat import started
 * - import_messages_inserted: Messages inserted into DB, extraction drain starting
 * - import_completed: Import finished successfully (shared pipeline extraction done)
 * - import_failed: Import encountered an error
 * - import_cancelled: Import was cancelled by user
 *
 * System:
 * - error: Error occurred during processing
 */
export type EventLogType =
  | 'event_ingested'
  | 'event_processed'
  | 'event_filtered'
  | 'intern_evaluated'
  | 'event_redacted'
  | 'event_unredacted'
  | 'image_linked'
  | 'claim_rejected'
  | 'entity_enriched'
  | 'question_proposed'
  | 'followup_evaluated'
  | 'question_asked'
  | 'question_answered'
  | 'question_responded'
  | 'question_retired'
  | 'conflict_detected'
  | 'facilitator_decision'
  | 'celebration_sent'
  | 'mediation_sent'
  | 'rule_changed'
  | 'lever_changed'
  | 'import_started'
  | 'import_messages_inserted'
  | 'import_completed'
  | 'import_failed'
  | 'import_cancelled'
  | 'error';

/**
 * Event categories.
 */
export type EventCategory =
  | 'user_action'
  | 'bot_action'
  | 'system_event'
  | 'coaching';

/**
 * Actor types.
 */
export type ActorType = 'user' | 'bot' | 'system';

/**
 * Severity levels.
 */
export type Severity = 'info' | 'warning' | 'error';

/**
 * An event log entry.
 */
export interface EventLogEntry {
  id: string;
  familyId: string;
  createdAt: Date;
  eventType: EventLogType;
  eventCategory: EventCategory;
  actor?: string;
  actorType?: ActorType;
  eventData?: Record<string, unknown>;
  conversationEventId?: string;
  sessionId?: string;
  identityId?: string;
  severity: Severity;
}

/**
 * How an Intern decision was reached. `'deterministic'` covers every
 * fast-path/rule-based/fallback-default resolution (commands, mentions, DM
 * detection, the free heuristic, error fallbacks) -- none of these call an
 * LLM. `'model'` means the routing filter's AI provider call actually ran
 * and produced the verdict. Must be explicit in `RoutingResult`/
 * `RoutingProcessorResult`, not inferred from `tokensUsed === undefined`.
 */
export type InternDecisionMethod = 'deterministic' | 'model';

/**
 * `event_data` payload for an `intern_evaluated` event -- written exactly
 * once per `InternAgent.route()` resolution, for every ingress (live chat,
 * Studio import, CLI import). Derived processing data, not family knowledge
 * or mutable workflow state: history, never a later pipeline input. No raw
 * message content is copied in; `conversation_event_id` on the entry links
 * back to the immutable source event.
 */
export interface InternEvaluatedEventData {
  /** Where Intern routed the message. */
  action: 'ignore' | 'admin' | 'scribe' | 'historian';
  /**
   * Whether the message was judged relevant for Scribe extraction. `null`
   * for `admin` -- routing to admin is deterministic command/DM/mention
   * handling, not a Scribe-relevance judgment.
   */
  relevant: boolean | null;
  /** Reason for the decision (human-readable, no raw message content). */
  reason: string;
  /** Detected language of the message, when known. */
  language?: LanguageCode;
  /** How the decision was reached -- see `InternDecisionMethod`. */
  method: InternDecisionMethod;
  /** Model id, present only when `method === 'model'`. */
  model?: string;
  /** Tokens used, present only when `method === 'model'`. */
  tokensUsed?: number;
}

/**
 * What one story follow-up evaluation concluded, as a stable category safe
 * to persist (no family content). `declined` is the model's own decision;
 * `suppressed_pacing` is the hook's pacing pre-check (no model call);
 * `no_text`, `empty_question` and `ungrounded_names` are deterministic guards
 * that withheld a question; `provider_error` and `unparseable_response` are
 * failures -- silence nobody chose (hardening J).
 */
export type FollowupOutcome =
  | 'asked'
  | 'declined'
  | 'suppressed_pacing'
  | 'no_text'
  | 'empty_question'
  | 'ungrounded_names'
  | 'provider_error'
  | 'unparseable_response';

export const FOLLOWUP_FAILURE_OUTCOMES: readonly FollowupOutcome[] = [
  'provider_error',
  'unparseable_response',
];

/**
 * `event_data` for a `followup_evaluated` event -- one per hook run that
 * did not propose a question (a proposal logs `question_proposed`
 * instead). Deliberately no `reason` text: the model's free-text reason can
 * quote family content.
 */
export interface FollowupEvaluatedEventData {
  outcome: Exclude<FollowupOutcome, 'asked'>;
}

/**
 * `event_data` for an `entity_enriched` event -- one per Registrar write
 * that changes fields on an existing entity. Enrichments have no backing
 * claim, so this entry (with the entry's `conversationEventId`, the source
 * message) is their only provenance. Field names only, never values: values
 * are family content.
 */
export interface EntityEnrichedEventData {
  entityType: 'person' | 'event' | 'story';
  entityId: string;
  fields: string[];
  /** The extraction marked the entity as re-extracted from context. */
  fromContext: boolean;
}

/**
 * Facilitator decision data for event log.
 */
export interface FacilitatorDecisionData {
  questionId: string;
  decision: 'ask' | 'wait';
  reason: string;
  rulesChecked: {
    realTimeLevers: boolean;
    coachingSignal: string;
    rateLimits: boolean;
  };
}

/**
 * Coaching adjustment data for event log.
 */
export interface CoachingAdjustmentData {
  ruleChanged: string;
  oldValue: unknown;
  newValue: unknown;
  reason: string;
  metrics: {
    responseRate?: number;
    ignoreRate?: number;
    interruptionCount?: number;
  };
}
