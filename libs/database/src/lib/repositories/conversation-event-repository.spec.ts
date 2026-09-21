import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConversationEventRepository } from './conversation-event-repository';

const mockSupabaseClient = {
  from: vi.fn(),
};

const createChainableMock = (finalResult: { data: any; error: any }) => {
  const chain: any = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.maybeSingle = vi.fn().mockResolvedValue(finalResult);
  return chain;
};

describe('ConversationEventRepository - findMostRecentOccurredAt', () => {
  let repo: ConversationEventRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = new ConversationEventRepository(mockSupabaseClient as any);
  });

  it('returns the most recent occurred_at timestamp for the family', async () => {
    const occurredAt = '2026-09-18T12:00:00.000Z';
    const chain = createChainableMock({
      data: { occurred_at: occurredAt },
      error: null,
    });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await repo.findMostRecentOccurredAt('family-123');

    expect(result).toEqual(new Date(occurredAt));
    expect(chain.select).toHaveBeenCalledWith('occurred_at');
    expect(chain.eq).toHaveBeenCalledWith('family_id', 'family-123');
    expect(chain.order).toHaveBeenCalledWith('occurred_at', {
      ascending: false,
    });
    expect(chain.limit).toHaveBeenCalledWith(1);
  });

  it('returns null when the family has no events', async () => {
    const chain = createChainableMock({ data: null, error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await repo.findMostRecentOccurredAt('family-123');

    expect(result).toBeNull();
  });

  it('throws when the query errors', async () => {
    const chain = createChainableMock({
      data: null,
      error: { message: 'db down' },
    });
    mockSupabaseClient.from.mockReturnValue(chain);

    await expect(repo.findMostRecentOccurredAt('family-123')).rejects.toThrow(
      'db down',
    );
  });
});

describe('ConversationEventRepository - consolidated join lookups', () => {
  let repo: ConversationEventRepository;

  // These queries chain `.in`/`.is` and resolve on `.order`.
  const createListChain = (finalResult: { data: any; error: any }) => {
    const chain: any = {};
    chain.select = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockReturnValue(chain);
    chain.in = vi.fn().mockReturnValue(chain);
    chain.is = vi.fn().mockReturnValue(chain);
    chain.order = vi.fn().mockResolvedValue(finalResult);
    return chain;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    repo = new ConversationEventRepository(mockSupabaseClient as any);
  });

  describe('findUnprocessedByType', () => {
    it('filters the events themselves to queued, unredacted rows', async () => {
      const chain = createListChain({
        data: [
          {
            id: 'evt-2',
            family_id: 'fam-1',
            actor_display_name: 'Bob',
            queue: { status: 'queued' },
            redacted: null,
          },
        ],
        error: null,
      });
      mockSupabaseClient.from.mockReturnValue(chain);

      const result = await repo.findUnprocessedByType(
        'fam-1',
        'conv-1',
        'join',
      );

      // `!inner` is what makes the embed filter restrict the events; the FK
      // hint is required since processing_queue has two FKs to this table.
      expect(chain.select).toHaveBeenCalledWith(
        expect.stringContaining(
          'queue:processing_queue!fk_processing_queue_event!inner(status)',
        ),
      );
      expect(chain.eq).toHaveBeenCalledWith('family_id', 'fam-1');
      expect(chain.eq).toHaveBeenCalledWith('conversation_id', 'conv-1');
      expect(chain.eq).toHaveBeenCalledWith('event_type', 'join');
      expect(chain.eq).toHaveBeenCalledWith('queue.status', 'queued');
      expect(chain.is).toHaveBeenCalledWith('redacted', null);
      expect(result).toEqual([
        { id: 'evt-2', familyId: 'fam-1', actorDisplayName: 'Bob' },
      ]);
    });
  });

  describe('findConsolidatedInto', () => {
    it('finds events whose queue row was absorbed into any of the given events', async () => {
      const chain = createListChain({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(chain);

      await repo.findConsolidatedInto('fam-1', ['evt-1', 'evt-3']);

      expect(chain.select).toHaveBeenCalledWith(
        expect.stringContaining(
          'queue:processing_queue!fk_processing_queue_event!inner(consolidated_into_event_id)',
        ),
      );
      expect(chain.eq).toHaveBeenCalledWith('family_id', 'fam-1');
      expect(chain.in).toHaveBeenCalledWith(
        'queue.consolidated_into_event_id',
        ['evt-1', 'evt-3'],
      );
      expect(chain.is).toHaveBeenCalledWith('redacted', null);
    });

    it('skips the query for an empty id list', async () => {
      const result = await repo.findConsolidatedInto('fam-1', []);

      expect(result).toEqual([]);
      expect(mockSupabaseClient.from).not.toHaveBeenCalled();
    });

    it('throws when the query errors', async () => {
      const chain = createListChain({
        data: null,
        error: { message: 'db down' },
      });
      mockSupabaseClient.from.mockReturnValue(chain);

      await expect(
        repo.findConsolidatedInto('fam-1', ['evt-1']),
      ).rejects.toThrow('db down');
    });
  });
});
