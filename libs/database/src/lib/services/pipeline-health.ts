import type { DatabaseClient } from '../client';
import {
  FOLLOWUP_FAILURE_OUTCOMES,
  type FollowupOutcome,
  type OutboundMessage,
  type QueueItem,
} from '@sobremesa/shared-types';
import { ProcessingQueueRepository } from '../repositories/processing-queue-repository.js';
import { OutboundMessageRepository } from '../repositories/outbound-message-repository.js';
import { EventLogRepository } from '../repositories/event-log-repository.js';

/** Matches `dequeueAny`'s default lease timeout. */
const DEFAULT_STALE_LOCK_MS = 5 * 60 * 1000;
/** A send claim normally confirms within seconds; this long means it never will. */
const DEFAULT_STALE_PENDING_MS = 10 * 60 * 1000;
/** A due row this old means nothing is draining the family's queue. */
const DEFAULT_BACKLOG_MS = 15 * 60 * 1000;

/** Silence the system chose -- counted, never alerted on. */
const FOLLOWUP_SILENCE_OUTCOMES = [
  'declined',
  'suppressed_pacing',
  'no_text',
  'empty_question',
  'ungrounded_names',
] as const satisfies readonly FollowupOutcome[];

const RETIRE_REASONS = ['expired', 'superseded_by_activity'] as const;

export interface PipelineHealthOptions {
  /** Window start for event-style records (sends, follow-up outcomes). */
  since: Date;
  staleLockMs?: number;
  stalePendingMs?: number;
  backlogMs?: number;
}

export interface QueueIssue {
  itemId: string;
  eventId: string;
  intent: QueueItem['intent'];
  attempts: number;
  lastError?: string;
  at: Date;
}

export type OutboundIssue = Omit<OutboundMessage, 'content'>;

export interface FollowupFailure {
  eventId?: string;
  outcome: FollowupOutcome;
  at: Date;
}

/**
 * One family's operator report (hardening J). `failures` is everything that
 * went wrong and needs a look; `silence` is everything the system chose not
 * to do. The two are never summed together.
 */
export interface FamilyPipelineHealth {
  familyId: string;
  since: Date;
  failureCount: number;
  failures: {
    /** Every currently dead-lettered row -- state, not windowed. */
    queueErrors: QueueIssue[];
    queueErrorCount: number;
    /** 'processing' rows whose lock outlived the lease timeout. */
    staleProcessing: QueueIssue[];
    /** Oldest due 'queued' row, when it has waited past the backlog threshold. */
    backlog: QueueIssue | null;
    /** failed/unknown sends in the window, plus every stale pending claim. */
    outbound: OutboundIssue[];
    followup: FollowupFailure[];
  };
  silence: {
    followup: Record<(typeof FOLLOWUP_SILENCE_OUTCOMES)[number], number>;
    questionsRetired: Record<(typeof RETIRE_REASONS)[number], number>;
  };
  activity: {
    followupsProposed: number;
    questionsAsked: number;
  };
  /** Slot for hardening H's usage and stop status. */
  spend: { status: 'not_implemented'; note: string };
}

/**
 * `mapRowToCamelCase` leaves timestamps as the ISO strings PostgREST
 * returns, whatever the TypeScript type says -- normalize before any math.
 */
function toDate(value: Date | string): Date {
  return new Date(value);
}

function toQueueIssue(item: QueueItem, at: Date | undefined): QueueIssue {
  return {
    itemId: item.id,
    eventId: item.conversationEventId,
    intent: item.intent,
    attempts: item.attempts,
    lastError: item.lastError,
    at: toDate(at ?? item.queuedAt),
  };
}

/**
 * Builds the operator report from data the pipeline already writes: the
 * processing queue, the outbound ledger, and the event log. Read-only and
 * family-scoped; recovery stays a separate, deliberate step (see
 * `spec/message-lifecycle.md` §4.7).
 */
export class PipelineHealthService {
  private queueRepo: ProcessingQueueRepository;
  private outboundRepo: OutboundMessageRepository;
  private eventLog: EventLogRepository;

  constructor(options: {
    dbClient?: DatabaseClient;
    queueRepo?: ProcessingQueueRepository;
    outboundRepo?: OutboundMessageRepository;
    eventLog?: EventLogRepository;
  }) {
    const { dbClient } = options;
    const queueRepo =
      options.queueRepo ??
      (dbClient ? new ProcessingQueueRepository(dbClient) : undefined);
    const outboundRepo =
      options.outboundRepo ??
      (dbClient ? new OutboundMessageRepository(dbClient) : undefined);
    const eventLog =
      options.eventLog ??
      (dbClient ? new EventLogRepository(dbClient) : undefined);

    if (!queueRepo || !outboundRepo || !eventLog) {
      throw new Error(
        'PipelineHealthService requires either dbClient or all repository instances',
      );
    }

    this.queueRepo = queueRepo;
    this.outboundRepo = outboundRepo;
    this.eventLog = eventLog;
  }

  async report(
    familyId: string,
    options: PipelineHealthOptions,
  ): Promise<FamilyPipelineHealth> {
    const now = Date.now();
    const { since } = options;
    const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    const stalePendingMs = options.stalePendingMs ?? DEFAULT_STALE_PENDING_MS;
    const backlogMs = options.backlogMs ?? DEFAULT_BACKLOG_MS;

    const countFollowup = (outcome: FollowupOutcome) =>
      this.eventLog.countInWindow(familyId, 'followup_evaluated', since, {
        dataEquals: { outcome },
      });

    const [
      queueErrors,
      queueErrorCount,
      stale,
      oldestDue,
      outbound,
      followupFailureEvents,
      silenceCounts,
      retiredCounts,
      followupsProposed,
      questionsAsked,
    ] = await Promise.all([
      this.queueRepo.getErrors(familyId, { limit: 50 }),
      this.queueRepo.getErrorCount(familyId),
      this.queueRepo.findStale(familyId, new Date(now - staleLockMs)),
      this.queueRepo.findOldestDue(familyId),
      this.outboundRepo.findNeedingAttention(familyId, {
        since,
        pendingBefore: new Date(now - stalePendingMs),
      }),
      this.eventLog.findInWindow(familyId, 'followup_evaluated', since, {
        severity: 'error',
        limit: 50,
      }),
      Promise.all(FOLLOWUP_SILENCE_OUTCOMES.map(countFollowup)),
      Promise.all(
        RETIRE_REASONS.map((reason) =>
          this.eventLog.countInWindow(familyId, 'question_retired', since, {
            dataEquals: { reason },
          }),
        ),
      ),
      this.eventLog.countInWindow(familyId, 'question_proposed', since, {
        actor: 'followup',
      }),
      this.eventLog.countInWindow(familyId, 'question_asked', since),
    ]);

    const backlog =
      oldestDue && now - toDate(oldestDue.processAfter).getTime() > backlogMs
        ? toQueueIssue(oldestDue, oldestDue.processAfter)
        : null;

    const followupFailures: FollowupFailure[] = followupFailureEvents
      .map((entry) => ({
        eventId: entry.conversationEventId,
        outcome: entry.eventData?.['outcome'] as FollowupOutcome,
        at: toDate(entry.createdAt),
      }))
      .filter((f) => FOLLOWUP_FAILURE_OUTCOMES.includes(f.outcome));

    const failures = {
      queueErrors: queueErrors.map((item) => toQueueIssue(item, item.queuedAt)),
      queueErrorCount,
      staleProcessing: stale.map((item) => toQueueIssue(item, item.lockedAt)),
      backlog,
      outbound,
      followup: followupFailures,
    };

    return {
      familyId,
      since,
      failureCount:
        queueErrorCount +
        failures.staleProcessing.length +
        (backlog ? 1 : 0) +
        outbound.length +
        followupFailures.length,
      failures,
      silence: {
        followup: Object.fromEntries(
          FOLLOWUP_SILENCE_OUTCOMES.map((o, i) => [o, silenceCounts[i]]),
        ) as FamilyPipelineHealth['silence']['followup'],
        questionsRetired: Object.fromEntries(
          RETIRE_REASONS.map((r, i) => [r, retiredCounts[i]]),
        ) as FamilyPipelineHealth['silence']['questionsRetired'],
      },
      activity: { followupsProposed, questionsAsked },
      spend: {
        status: 'not_implemented',
        note: 'Spend usage and stop status arrive with hardening H.',
      },
    };
  }
}
