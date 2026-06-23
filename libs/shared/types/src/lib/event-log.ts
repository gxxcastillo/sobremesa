/**
 * Event types for the audit log.
 *
 * Event lifecycle:
 * - event_ingested: Raw message received from chat provider
 * - event_processed: Message processed by Scribe/Curator
 * - event_filtered: Message filtered out by Intern (spam, off-topic, etc.)
 * - event_redacted: Event redacted for privacy
 * - event_unredacted: Event redaction reversed
 * - image_linked: Image linked to a conversation event
 *
 * Question lifecycle:
 * - question_proposed: Scribe proposes a follow-up question
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
 * - import_messages_inserted: Messages inserted into DB, awaiting Intern review
 * - import_intern_complete: Intern classification complete
 * - import_completed: Import finished successfully (Scribe processing done)
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
  | 'event_redacted'
  | 'event_unredacted'
  | 'image_linked'
  | 'question_proposed'
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
  | 'import_intern_complete'
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
