import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PipelineHealthService } from './pipeline-health';

const FAMILY_ID = 'family-1';
const NOW = new Date('2026-10-01T12:00:00Z');
const SINCE = new Date('2026-09-30T12:00:00Z');

function minutesAgo(minutes: number): string {
  // ISO strings, as PostgREST rows actually arrive (see toDate()).
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

function queueRow(overrides: Record<string, unknown>) {
  return {
    id: 'item-1',
    familyId: FAMILY_ID,
    conversationEventId: 'event-1',
    queuedAt: minutesAgo(60),
    processAfter: minutesAgo(60),
    status: 'queued',
    attempts: 0,
    priority: 5,
    intent: 'live',
    ...overrides,
  };
}

const queueRepo = {
  getErrors: vi.fn(),
  getErrorCount: vi.fn(),
  findStale: vi.fn(),
  findOldestDue: vi.fn(),
};
const outboundRepo = { findNeedingAttention: vi.fn() };
const eventLog = { countInWindow: vi.fn(), findInWindow: vi.fn() };

function createService() {
  return new PipelineHealthService({
    queueRepo: queueRepo as any,
    outboundRepo: outboundRepo as any,
    eventLog: eventLog as any,
  });
}

describe('PipelineHealthService.report', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    queueRepo.getErrors.mockResolvedValue([]);
    queueRepo.getErrorCount.mockResolvedValue(0);
    queueRepo.findStale.mockResolvedValue([]);
    queueRepo.findOldestDue.mockResolvedValue(null);
    outboundRepo.findNeedingAttention.mockResolvedValue([]);
    eventLog.countInWindow.mockResolvedValue(0);
    eventLog.findInWindow.mockResolvedValue([]);
  });

  it('reports a quiet, healthy family as zero failures', async () => {
    const report = await createService().report(FAMILY_ID, { since: SINCE });

    expect(report.failureCount).toBe(0);
    expect(report.failures.backlog).toBeNull();
    expect(report.spend.status).toBe('not_implemented');
  });

  it('surfaces dead-lettered, stale and backed-up queue work with the ids to act on', async () => {
    queueRepo.getErrors.mockResolvedValue([
      queueRow({
        id: 'dead-1',
        conversationEventId: 'event-dead',
        status: 'error',
        attempts: 3,
        lastError: 'Scribe parse error',
      }),
    ]);
    queueRepo.getErrorCount.mockResolvedValue(1);
    queueRepo.findStale.mockResolvedValue([
      queueRow({
        id: 'stuck-1',
        conversationEventId: 'event-stuck',
        status: 'processing',
        lockedAt: minutesAgo(30),
      }),
    ]);
    queueRepo.findOldestDue.mockResolvedValue(
      queueRow({ id: 'waiting-1', processAfter: minutesAgo(40) }),
    );

    const report = await createService().report(FAMILY_ID, { since: SINCE });

    expect(queueRepo.findStale).toHaveBeenCalledWith(
      FAMILY_ID,
      new Date(NOW.getTime() - 5 * 60_000),
    );
    expect(report.failures.queueErrors).toEqual([
      expect.objectContaining({
        itemId: 'dead-1',
        eventId: 'event-dead',
        lastError: 'Scribe parse error',
      }),
    ]);
    expect(report.failures.staleProcessing[0]).toMatchObject({
      itemId: 'stuck-1',
      at: new Date(minutesAgo(30)),
    });
    expect(report.failures.backlog).toMatchObject({ itemId: 'waiting-1' });
    expect(report.failureCount).toBe(3);
  });

  it('does not flag a due row that has only just become due', async () => {
    queueRepo.findOldestDue.mockResolvedValue(
      queueRow({ processAfter: minutesAgo(2) }),
    );

    const report = await createService().report(FAMILY_ID, { since: SINCE });

    expect(report.failures.backlog).toBeNull();
    expect(report.failureCount).toBe(0);
  });

  it('counts failed and unknown sends as failures', async () => {
    outboundRepo.findNeedingAttention.mockResolvedValue([
      { id: 'out-1', status: 'failed', dedupKey: 'facilitator:question:q1' },
      { id: 'out-2', status: 'unknown', dedupKey: 'historian-answer:e2' },
    ]);

    const report = await createService().report(FAMILY_ID, { since: SINCE });

    expect(outboundRepo.findNeedingAttention).toHaveBeenCalledWith(FAMILY_ID, {
      since: SINCE,
      pendingBefore: new Date(NOW.getTime() - 10 * 60_000),
    });
    expect(report.failures.outbound).toHaveLength(2);
    expect(report.failureCount).toBe(2);
  });

  it('keeps follow-up provider failures apart from silence the system chose', async () => {
    eventLog.findInWindow.mockResolvedValue([
      {
        conversationEventId: 'event-9',
        eventData: { outcome: 'provider_error' },
        createdAt: minutesAgo(10),
      },
    ]);
    eventLog.countInWindow.mockImplementation(
      async (_family, eventType, _since, filter) => {
        if (eventType === 'followup_evaluated') {
          return (
            { declined: 4, suppressed_pacing: 2 }[
              filter?.dataEquals?.outcome as string
            ] ?? 0
          );
        }
        if (eventType === 'question_retired') {
          return filter?.dataEquals?.reason === 'expired' ? 1 : 0;
        }
        if (eventType === 'question_proposed') return 1;
        return 0;
      },
    );

    const report = await createService().report(FAMILY_ID, { since: SINCE });

    expect(eventLog.findInWindow).toHaveBeenCalledWith(
      FAMILY_ID,
      'followup_evaluated',
      SINCE,
      { severity: 'error', limit: 50 },
    );
    expect(report.failures.followup).toEqual([
      {
        eventId: 'event-9',
        outcome: 'provider_error',
        at: new Date(minutesAgo(10)),
      },
    ]);
    expect(report.failureCount).toBe(1);
    expect(report.silence.followup).toMatchObject({
      declined: 4,
      suppressed_pacing: 2,
      ungrounded_names: 0,
    });
    expect(report.silence.questionsRetired).toEqual({
      expired: 1,
      superseded_by_activity: 0,
    });
    expect(report.activity.followupsProposed).toBe(1);
  });
});
