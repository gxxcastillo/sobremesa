import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  };
  let mockFamilyRepo: { findById: ReturnType<typeof vi.fn> };
  let mockEventLog: { log: ReturnType<typeof vi.fn> };
  let mockQueueRepo: {
    findPendingByEventIds: ReturnType<typeof vi.fn>;
    completeMany: ReturnType<typeof vi.fn>;
  };
  let mockMessageSender: { sendMessage: ReturnType<typeof vi.fn> };
  let agent: AdminAgent;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEventRepo = {
      findById: vi.fn(),
      findUnprocessedByType: vi.fn().mockResolvedValue([]),
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
    mockMessageSender = { sendMessage: vi.fn().mockResolvedValue(1) };

    agent = new AdminAgent({
      messageSender: mockMessageSender as any,
      eventRepo: mockEventRepo as any,
      familyRepo: mockFamilyRepo as any,
      eventLog: mockEventLog as any,
      queueRepo: mockQueueRepo as any,
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
});
