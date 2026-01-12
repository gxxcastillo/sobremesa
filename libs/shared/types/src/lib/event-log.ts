/**
 * Event types for the audit log.
 */
export type EventLogType =
  | 'event_ingested'
  | 'event_processed'
  | 'event_filtered'
  | 'question_proposed'
  | 'question_asked'
  | 'question_answered'
  | 'question_retired'
  | 'conflict_detected'
  | 'facilitator_decision'
  | 'coaching_adjustment'
  | 'celebration_sent'
  | 'mediation_sent'
  | 'rule_changed'
  | 'lever_changed'
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
  sourceEventId?: string;
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
