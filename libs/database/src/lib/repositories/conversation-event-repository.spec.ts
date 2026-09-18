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
