import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageDeliveryError } from '@sobremesa/shared-types';
import { AdminAgent } from './admin';

const mockLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const FAMILY_ID = 'fam-1';
const CONVERSATION_ID = 'conv-1';

function createJoinEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'evt-1',
    familyId: FAMILY_ID,
    conversationId: CONVERSATION_ID,
    eventType: 'join',
    actorExternalId: 'user-1',
    actorDisplayName: 'Alice',
    ...overrides,
  };
}

describe('AdminAgent - handleConsolidatedJoin', () => {
  let mockEventRepo: {
    findById: ReturnType<typeof vi.fn>;
    findUnprocessedByType: ReturnType<typeof vi.fn>;
    findConsolidatedInto: ReturnType<typeof vi.fn>;
  };
  let mockFamilyRepo: { findById: ReturnType<typeof vi.fn> };
  let mockEventLog: { log: ReturnType<typeof vi.fn> };
  let mockQueueRepo: {
    findPendingByEventIds: ReturnType<typeof vi.fn>;
    completeMany: ReturnType<typeof vi.fn>;
  };
  let mockMessageSender: { sendMessage: ReturnType<typeof vi.fn> };
  let mockOutboundRepo: { findByDedupKey: ReturnType<typeof vi.fn> };
  let agent: AdminAgent;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEventRepo = {
      findById: vi.fn(),
      findUnprocessedByType: vi.fn().mockResolvedValue([]),
      findConsolidatedInto: vi.fn().mockResolvedValue([]),
    };
    mockFamilyRepo = {
      findById: vi
        .fn()
        .mockResolvedValue({ id: FAMILY_ID, name: 'The Smiths', config: {} }),
    };
    mockEventLog = { log: vi.fn().mockResolvedValue(undefined) };
    mockQueueRepo = {
      findPendingByEventIds: vi.fn().mockResolvedValue([]),
      completeMany: vi.fn().mockResolvedValue(undefined),
    };
    mockMessageSender = {
      sendMessage: vi.fn().mockResolvedValue({ status: 'sent', messageId: 1 }),
    };
    mockOutboundRepo = { findByDedupKey: vi.fn().mockResolvedValue(null) };

    agent = new AdminAgent({
      messageSender: mockMessageSender as any,
      eventRepo: mockEventRepo as any,
      familyRepo: mockFamilyRepo as any,
      eventLog: mockEventLog as any,
      queueRepo: mockQueueRepo as any,
      outboundRepo: mockOutboundRepo as any,
      logger: mockLogger as any,
    });
  });

  it('sends a welcome message for a solo join, even with zero other pending join events', async () => {
    const event = createJoinEvent();
    mockEventRepo.findById.mockResolvedValue(event);
    // The triggering event's own queue item is already 'processing', so
    // findUnprocessedByType (which only matches 'queued'/null) correctly
    // returns nothing else pending — this is the exact solo-join shape.
    mockEventRepo.findUnprocessedByType.mockResolvedValue([]);

    const result = await agent.handle(event.id, FAMILY_ID, 'member_event');

    expect(result).toEqual({
      success: true,
      action: 'member_event',
      messageSent: true,
    });
    expect(mockMessageSender.sendMessage).toHaveBeenCalledTimes(1);
    const [, payload] = mockMessageSender.sendMessage.mock.calls[0];
    expect(payload.text).toContain('Alice');
  });

  it('includes the triggering member alongside other pending joins, not just the others', async () => {
    const triggeringEvent = createJoinEvent({
      id: 'evt-1',
      actorExternalId: 'user-1',
      actorDisplayName: 'Alice',
    });
    const otherEvent = createJoinEvent({
      id: 'evt-2',
      actorExternalId: 'user-2',
      actorDisplayName: 'Bob',
    });
    mockEventRepo.findById.mockResolvedValue(triggeringEvent);
    // findUnprocessedByType only ever returns *other* still-queued joins —
    // never the triggering event itself.
    mockEventRepo.findUnprocessedByType.mockResolvedValue([otherEvent]);

    const result = await agent.handle(
      triggeringEvent.id,
      FAMILY_ID,
      'member_event',
    );

    expect(result.messageSent).toBe(true);
    const [, payload] = mockMessageSender.sendMessage.mock.calls[0];
    expect(payload.text).toContain('Alice');
    expect(payload.text).toContain('Bob');
  });

  it('does not double-count the triggering event if it is somehow also returned as pending', async () => {
    const event = createJoinEvent();
    mockEventRepo.findById.mockResolvedValue(event);
    mockEventRepo.findUnprocessedByType.mockResolvedValue([event]);

    const result = await agent.handle(event.id, FAMILY_ID, 'member_event');

    expect(result.messageSent).toBe(true);
    const [, payload] = mockMessageSender.sendMessage.mock.calls[0];
    // "Alice" should appear once in the notification, not twice.
    expect(payload.text.split('Alice').length - 1).toBe(1);
  });

  it('speaks the language chosen at import to an imported family', async () => {
    // Import writes `defaultLanguage`, never `languages.primary`.
    mockFamilyRepo.findById.mockResolvedValue({
      id: FAMILY_ID,
      name: 'The Smiths',
      config: { defaultLanguage: 'es' },
    });
    const event = createJoinEvent();
    mockEventRepo.findById.mockResolvedValue(event);

    await agent.handle(event.id, FAMILY_ID, 'member_event');

    const [, payload] = mockMessageSender.sendMessage.mock.calls[0];
    expect(payload.text).toContain('Alice se unió al chat de The Smiths.');
  });

  describe('outbound-send-reliability-plan.md #3 -- dedup key', () => {
    it('claims a dedup key scoped to the triggering event id', async () => {
      const event = createJoinEvent();
      mockEventRepo.findById.mockResolvedValue(event);

      await agent.handle(event.id, FAMILY_ID, 'member_event');

      const [, , options] = mockMessageSender.sendMessage.mock.calls[0];
      expect(options.dedup).toEqual({
        familyId: FAMILY_ID,
        key: `admin:join:${event.id}`,
        conversationEventId: event.id,
      });
    });

    it('a "duplicate" outcome from the ledger (retried join already sent) still reports success with one send call', async () => {
      const event = createJoinEvent();
      mockEventRepo.findById.mockResolvedValue(event);
      mockMessageSender.sendMessage.mockResolvedValue({
        status: 'duplicate',
        messageId: 42,
      });

      const result = await agent.handle(event.id, FAMILY_ID, 'member_event');

      expect(result).toEqual({
        success: true,
        action: 'member_event',
        messageSent: true,
      });
      expect(mockMessageSender.sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('a retry after the welcome was already attempted', () => {
    const newcomer = createJoinEvent({
      id: 'evt-new',
      actorExternalId: 'user-new',
      actorDisplayName: 'Marta',
    });

    it.each(['sent', 'pending', 'unknown'])(
      'leaves a newly queued join alone when the ledger row is %s, so it gets its own welcome',
      async (status) => {
        const trigger = createJoinEvent();
        mockEventRepo.findById.mockResolvedValue(trigger);
        mockEventRepo.findUnprocessedByType.mockResolvedValue([newcomer]);
        mockOutboundRepo.findByDedupKey.mockResolvedValue({ status });
        mockMessageSender.sendMessage.mockResolvedValue({
          status: 'duplicate',
        });

        const result = await agent.handle(
          trigger.id,
          FAMILY_ID,
          'member_event',
        );

        expect(result.success).toBe(true);
        expect(mockOutboundRepo.findByDedupKey).toHaveBeenCalledWith(
          FAMILY_ID,
          `admin:join:${trigger.id}`,
        );
        expect(mockEventRepo.findUnprocessedByType).not.toHaveBeenCalled();
        expect(mockQueueRepo.findPendingByEventIds).toHaveBeenCalledWith(
          FAMILY_ID,
          [trigger.id],
        );
        const [, message] = mockMessageSender.sendMessage.mock.calls[0];
        expect(message.text).not.toContain('Marta');
      },
    );

    it('still absorbs a newcomer when the earlier attempt provably failed, since the retry really sends', async () => {
      const trigger = createJoinEvent();
      mockEventRepo.findById.mockResolvedValue(trigger);
      mockEventRepo.findUnprocessedByType.mockResolvedValue([newcomer]);
      mockOutboundRepo.findByDedupKey.mockResolvedValue({ status: 'failed' });

      await agent.handle(trigger.id, FAMILY_ID, 'member_event');

      expect(mockQueueRepo.findPendingByEventIds).toHaveBeenCalledWith(
        FAMILY_ID,
        [trigger.id, newcomer.id],
      );
      const [, message] = mockMessageSender.sendMessage.mock.calls[0];
      expect(message.text).toContain('Marta');
    });
  });

  describe('outbound-send-reliability-plan.md #4 -- completeMany before send', () => {
    it('propagates a completeMany failure without sending, so the queue retries instead of reporting a delivered batch', async () => {
      const triggeringEvent = createJoinEvent({
        id: 'evt-1',
        actorExternalId: 'user-1',
        actorDisplayName: 'Alice',
      });
      const otherEvent = createJoinEvent({
        id: 'evt-2',
        actorExternalId: 'user-2',
        actorDisplayName: 'Bob',
      });
      mockEventRepo.findById.mockResolvedValue(triggeringEvent);
      mockEventRepo.findUnprocessedByType.mockResolvedValue([otherEvent]);
      mockQueueRepo.findPendingByEventIds.mockResolvedValue([
        { id: 'queue-2' },
      ]);
      mockQueueRepo.completeMany.mockRejectedValue(new Error('db unavailable'));

      const result = await agent.handle(
        triggeringEvent.id,
        FAMILY_ID,
        'member_event',
      );

      expect(result.success).toBe(false);
      expect(mockMessageSender.sendMessage).not.toHaveBeenCalled();
    });

    it('completes sibling queue items before sending the notification', async () => {
      const triggeringEvent = createJoinEvent({
        id: 'evt-1',
        actorExternalId: 'user-1',
        actorDisplayName: 'Alice',
      });
      const otherEvent = createJoinEvent({
        id: 'evt-2',
        actorExternalId: 'user-2',
        actorDisplayName: 'Bob',
      });
      mockEventRepo.findById.mockResolvedValue(triggeringEvent);
      mockEventRepo.findUnprocessedByType.mockResolvedValue([otherEvent]);
      mockQueueRepo.findPendingByEventIds.mockResolvedValue([
        { id: 'queue-2' },
      ]);

      const callOrder: string[] = [];
      mockQueueRepo.completeMany.mockImplementation(async () => {
        callOrder.push('completeMany');
      });
      mockMessageSender.sendMessage.mockImplementation(async () => {
        callOrder.push('sendMessage');
        return { status: 'sent', messageId: 1 };
      });

      const result = await agent.handle(
        triggeringEvent.id,
        FAMILY_ID,
        'member_event',
      );

      expect(result.messageSent).toBe(true);
      expect(mockQueueRepo.completeMany).toHaveBeenCalledWith(
        FAMILY_ID,
        ['queue-2'],
        { consolidatedIntoEventId: triggeringEvent.id },
      );
      expect(callOrder).toEqual(['completeMany', 'sendMessage']);
    });
  });

  describe('a send that throws after siblings were absorbed', () => {
    // Stand-in for processing_queue that keeps state between attempts, so
    // each attempt's queries see what earlier attempts wrote -- as the real
    // queries do.
    type QueueRow = {
      id: string;
      event: ReturnType<typeof createJoinEvent>;
      status: 'queued' | 'processing' | 'done';
      consolidatedInto?: string;
    };
    let rows: QueueRow[];

    function useQueueState(initial: QueueRow[]) {
      rows = initial;
      mockEventRepo.findById.mockImplementation(
        async (_familyId: string, id: string) =>
          rows.find((r) => r.event.id === id)?.event ?? null,
      );
      mockEventRepo.findUnprocessedByType.mockImplementation(async () =>
        rows.filter((r) => r.status === 'queued').map((r) => r.event),
      );
      mockEventRepo.findConsolidatedInto.mockImplementation(
        async (_familyId: string, eventIds: string[]) =>
          rows
            .filter(
              (r) =>
                r.consolidatedInto && eventIds.includes(r.consolidatedInto),
            )
            .map((r) => r.event),
      );
      mockQueueRepo.findPendingByEventIds.mockImplementation(
        async (_familyId: string, eventIds: string[]) =>
          rows
            .filter(
              (r) => r.status === 'queued' && eventIds.includes(r.event.id),
            )
            .map((r) => ({ id: r.id })),
      );
      mockQueueRepo.completeMany.mockImplementation(
        async (
          _familyId: string,
          ids: string[],
          options?: { consolidatedIntoEventId?: string },
        ) => {
          for (const r of rows.filter((row) => ids.includes(row.id))) {
            r.status = 'done';
            r.consolidatedInto = options?.consolidatedIntoEventId;
          }
        },
      );
    }

    /** One queue attempt: lease the row, run the handler, settle the row. */
    async function attempt(eventId: string) {
      const row = rows.find((r) => r.event.id === eventId);
      if (!row) throw new Error(`no queue row for ${eventId}`);
      row.status = 'processing';
      const result = await agent.handle(eventId, FAMILY_ID, 'member_event');
      row.status = result.success ? 'done' : 'queued';
      return result;
    }

    const alice = createJoinEvent({
      id: 'evt-alice',
      actorExternalId: 'user-alice',
      actorDisplayName: 'Alice',
    });
    const bob = createJoinEvent({
      id: 'evt-bob',
      actorExternalId: 'user-bob',
      actorDisplayName: 'Bob',
    });
    const carol = createJoinEvent({
      id: 'evt-carol',
      actorExternalId: 'user-carol',
      actorDisplayName: 'Carol',
    });

    it('the retry still welcomes the sibling the failed attempt marked done', async () => {
      useQueueState([
        { id: 'q-alice', event: alice, status: 'queued' },
        { id: 'q-bob', event: bob, status: 'queued' },
      ]);
      mockMessageSender.sendMessage
        .mockRejectedValueOnce(
          new MessageDeliveryError('403: bot was kicked from the group chat'),
        )
        .mockResolvedValue({ status: 'sent', messageId: 1 });

      const first = await attempt(alice.id);
      expect(first.success).toBe(false);
      // Bob's row is done -- only the link brings him back on the retry.
      expect(rows.find((r) => r.id === 'q-bob')).toMatchObject({
        status: 'done',
        consolidatedInto: alice.id,
      });

      const retry = await attempt(alice.id);

      expect(retry.success).toBe(true);
      const [, payload, options] = mockMessageSender.sendMessage.mock.calls[1];
      expect(payload.text).toContain('Alice');
      expect(payload.text).toContain('Bob');
      // Same key as the failed attempt, so the ledger reclaims it rather
      // than treating the retry as a new welcome.
      expect(options.dedup.key).toBe(`admin:join:${alice.id}`);
      // The logged member list is the list onboarding runs for.
      expect(mockEventLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          eventData: expect.objectContaining({
            memberNames: ['Alice', 'Bob'],
          }),
        }),
      );
    });

    it('a later join that absorbs a trigger awaiting retry also welcomes what that trigger absorbed', async () => {
      useQueueState([
        { id: 'q-alice', event: alice, status: 'queued' },
        { id: 'q-bob', event: bob, status: 'queued' },
      ]);
      mockMessageSender.sendMessage
        .mockRejectedValueOnce(
          new MessageDeliveryError('429: Too Many Requests'),
        )
        .mockResolvedValue({ status: 'sent', messageId: 1 });

      await attempt(alice.id);
      // Carol joins while Alice's row waits out its retry delay, and her
      // row is leased first.
      rows.push({ id: 'q-carol', event: carol, status: 'queued' });

      const result = await attempt(carol.id);

      expect(result.success).toBe(true);
      const [, payload] = mockMessageSender.sendMessage.mock.calls[1];
      expect(payload.text).toContain('Carol');
      expect(payload.text).toContain('Alice');
      expect(payload.text).toContain('Bob');
      expect(rows.find((r) => r.id === 'q-alice')).toMatchObject({
        status: 'done',
        consolidatedInto: carol.id,
      });
    });
  });
});
