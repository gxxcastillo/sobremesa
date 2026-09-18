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
  chain.or = vi.fn().mockReturnValue(chain);
  chain.lte = vi.fn().mockReturnValue(chain);
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

describe('QuestionRepository - findPending', () => {
  let questionRepo: QuestionRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    questionRepo = new QuestionRepository(mockSupabaseClient as any);
  });

  it('excludes questions whose expires_at is in the past', async () => {
    const chain = createChainableMock({ data: [], error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    await questionRepo.findPending('family-123');

    expect(chain.eq).toHaveBeenCalledWith('status', 'proposed');
    expect(chain.or).toHaveBeenCalledWith(
      expect.stringMatching(
        /^expires_at\.is\.null,expires_at\.gt\.\d{4}-\d\d-\d\dT/,
      ),
    );
  });

  it('maps returned rows to Question', async () => {
    const chain = createChainableMock({
      data: [{ id: 'q1', family_id: 'family-123', status: 'proposed' }],
      error: null,
    });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await questionRepo.findPending('family-123');

    expect(result).toEqual([
      { id: 'q1', familyId: 'family-123', status: 'proposed' },
    ]);
  });

  it('throws when the query errors', async () => {
    const chain = createChainableMock({
      data: null,
      error: { message: 'boom' },
    });
    mockSupabaseClient.from.mockReturnValue(chain);

    await expect(questionRepo.findPending('family-123')).rejects.toThrow(
      'Failed to find pending questions: boom',
    );
  });
});

describe('QuestionRepository - findExpiredPending', () => {
  let questionRepo: QuestionRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    questionRepo = new QuestionRepository(mockSupabaseClient as any);
  });

  it('filters to proposed questions with a past expires_at', async () => {
    const chain = createChainableMock({ data: [], error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    await questionRepo.findExpiredPending('family-123');

    expect(chain.eq).toHaveBeenCalledWith('status', 'proposed');
    expect(chain.not).toHaveBeenCalledWith('expires_at', 'is', null);
    expect(chain.lte).toHaveBeenCalledWith(
      'expires_at',
      expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    );
  });

  it('throws when the query errors', async () => {
    const chain = createChainableMock({
      data: null,
      error: { message: 'boom' },
    });
    mockSupabaseClient.from.mockReturnValue(chain);

    await expect(questionRepo.findExpiredPending('family-123')).rejects.toThrow(
      'Failed to find expired pending questions: boom',
    );
  });
});

describe('QuestionRepository - hasWaitingOrRecent', () => {
  let questionRepo: QuestionRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    questionRepo = new QuestionRepository(mockSupabaseClient as any);
  });

  it('is true when a non-expired proposed question exists', async () => {
    const chain = createChainableMock({
      data: [{ id: 'q1', status: 'proposed' }],
      error: null,
    });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await questionRepo.hasWaitingOrRecent('family-123', 24);

    expect(result).toBe(true);
  });

  it('is true when the most recent ask is within the window, with no pending question', async () => {
    let call = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      call += 1;
      if (call === 1) {
        // findPending: nothing waiting
        return createChainableMock({ data: [], error: null });
      }
      // findMostRecentAskedAt: asked 1 hour ago
      const askedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      return createChainableMock({ data: { asked_at: askedAt }, error: null });
    });

    const result = await questionRepo.hasWaitingOrRecent('family-123', 24);

    expect(result).toBe(true);
  });

  it('is false when nothing is pending and the last ask is outside the window', async () => {
    let call = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      call += 1;
      if (call === 1) {
        return createChainableMock({ data: [], error: null });
      }
      const askedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      return createChainableMock({ data: { asked_at: askedAt }, error: null });
    });

    const result = await questionRepo.hasWaitingOrRecent('family-123', 24);

    expect(result).toBe(false);
  });

  it('is false when nothing is pending and nothing has ever been asked', async () => {
    let call = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      call += 1;
      if (call === 1) {
        return createChainableMock({ data: [], error: null });
      }
      return createChainableMock({ data: null, error: null });
    });

    const result = await questionRepo.hasWaitingOrRecent('family-123', 24);

    expect(result).toBe(false);
  });
});
