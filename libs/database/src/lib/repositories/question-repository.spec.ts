import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QuestionRepository } from './question-repository';

const mockSupabaseClient = {
  from: vi.fn(),
};

const createChainableMock = (finalResult: { data: any; error: any }) => {
  const chain: any = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.insert = vi.fn().mockReturnValue(chain);
  chain.update = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.in = vi.fn().mockReturnValue(chain);
  chain.not = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue(finalResult);
  chain.maybeSingle = vi.fn().mockResolvedValue(finalResult);
  chain.then = (resolve: (value: { data: unknown; error: unknown }) => void) =>
    resolve(finalResult);
  return chain;
};

describe('QuestionRepository - findMostRecentAskedAt', () => {
  let questionRepo: QuestionRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    questionRepo = new QuestionRepository(mockSupabaseClient as any);
  });

  it('returns the most recent asked_at timestamp', async () => {
    const askedAt = '2026-09-10T12:00:00.000Z';
    const chain = createChainableMock({
      data: { asked_at: askedAt },
      error: null,
    });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await questionRepo.findMostRecentAskedAt('family-123');

    expect(result).toEqual(new Date(askedAt));
    expect(chain.select).toHaveBeenCalledWith('asked_at');
    expect(chain.eq).toHaveBeenCalledWith('family_id', 'family-123');
    expect(chain.not).toHaveBeenCalledWith('asked_at', 'is', null);
    expect(chain.order).toHaveBeenCalledWith('asked_at', {
      ascending: false,
    });
    expect(chain.limit).toHaveBeenCalledWith(1);
  });

  it('is status-agnostic: an answered or retired question still counts', async () => {
    // No status filter is asserted on the chain -- only family_id and the
    // asked_at not-null guard. This is the regression case: an answered
    // question must still throttle the next ask.
    const askedAt = '2026-09-10T12:00:00.000Z';
    const chain = createChainableMock({
      data: { asked_at: askedAt },
      error: null,
    });
    mockSupabaseClient.from.mockReturnValue(chain);

    await questionRepo.findMostRecentAskedAt('family-123');

    expect(chain.eq).toHaveBeenCalledTimes(1);
    expect(chain.eq).toHaveBeenCalledWith('family_id', 'family-123');
  });

  it('returns null when no question has ever been asked', async () => {
    const chain = createChainableMock({ data: null, error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await questionRepo.findMostRecentAskedAt('family-123');

    expect(result).toBeNull();
  });

  it('throws when the query errors', async () => {
    const chain = createChainableMock({
      data: null,
      error: { message: 'boom' },
    });
    mockSupabaseClient.from.mockReturnValue(chain);

    await expect(
      questionRepo.findMostRecentAskedAt('family-123'),
    ).rejects.toThrow('Failed to find most recent asked_at: boom');
  });
});
