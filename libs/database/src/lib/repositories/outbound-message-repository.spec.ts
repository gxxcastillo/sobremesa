import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutboundMessageRepository } from './outbound-message-repository';

const mockSupabaseClient = {
  from: vi.fn(),
};

const createChainableMock = (finalResult: { data: any; error: any }) => {
  const chain: any = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.insert = vi.fn().mockReturnValue(chain);
  chain.update = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue(finalResult);
  return chain;
};

function callsInOrder(...chains: any[]) {
  let callCount = 0;
  mockSupabaseClient.from.mockImplementation(() => {
    const chain = chains[Math.min(callCount, chains.length - 1)];
    callCount++;
    return chain;
  });
}

const baseParams = {
  familyId: 'fam1',
  dedupKey: 'facilitator:question:q1',
  role: 'facilitator-question',
  chatId: 'chat1',
  content: 'Who is Ralph’s sister?',
  questionId: 'q1',
};

const rowFor = (overrides: Record<string, unknown> = {}) => ({
  id: 'om1',
  family_id: 'fam1',
  dedup_key: 'facilitator:question:q1',
  role: 'facilitator-question',
  chat_id: 'chat1',
  content: 'Who is Ralph’s sister?',
  status: 'pending',
  send_attempted_at: new Date().toISOString(),
  external_message_id: null,
  conversation_event_id: null,
  question_id: 'q1',
  attempts: 1,
  last_error: null,
  created_at: new Date().toISOString(),
  sent_at: null,
  ...overrides,
});

describe('OutboundMessageRepository - claim', () => {
  let repo: OutboundMessageRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = new OutboundMessageRepository(mockSupabaseClient as any);
  });

  it('inserts a fresh pending row, stamping send_attempted_at at claim time', async () => {
    const chain = createChainableMock({ data: rowFor(), error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await repo.claim(baseParams);

    expect(result.outcome).toBe('claimed');
    expect(result.message.id).toBe('om1');
    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        family_id: 'fam1',
        dedup_key: 'facilitator:question:q1',
        status: 'pending',
        attempts: 1,
        question_id: 'q1',
      }),
    );
    const insertedRow = chain.insert.mock.calls[0][0];
    expect(insertedRow.send_attempted_at).toBeTruthy();
  });

  it('returns "duplicate" without a second send when the existing row is already sent', async () => {
    const insertChain = createChainableMock({
      data: null,
      error: { code: '23505', message: 'duplicate key' },
    });
    const findChain = createChainableMock({
      data: rowFor({ status: 'sent', external_message_id: '999' }),
      error: null,
    });
    callsInOrder(insertChain, findChain);

    const result = await repo.claim(baseParams);

    expect(result.outcome).toBe('duplicate');
    expect(result.message.status).toBe('sent');
  });

  it('returns "ambiguous" (never resends) when the existing row is still pending', async () => {
    const insertChain = createChainableMock({
      data: null,
      error: { code: '23505', message: 'duplicate key' },
    });
    const findChain = createChainableMock({
      data: rowFor({ status: 'pending' }),
      error: null,
    });
    callsInOrder(insertChain, findChain);

    const result = await repo.claim(baseParams);

    expect(result.outcome).toBe('ambiguous');
  });

  it('returns "ambiguous" (never resends) when the existing row is unknown (5xx/network)', async () => {
    const insertChain = createChainableMock({
      data: null,
      error: { code: '23505', message: 'duplicate key' },
    });
    const findChain = createChainableMock({
      data: rowFor({ status: 'unknown', last_error: 'network timeout' }),
      error: null,
    });
    callsInOrder(insertChain, findChain);

    const result = await repo.claim(baseParams);

    expect(result.outcome).toBe('ambiguous');
  });

  it('reclaims a failed row: increments attempts, refreshes content, restamps the attempt', async () => {
    const insertChain = createChainableMock({
      data: null,
      error: { code: '23505', message: 'duplicate key' },
    });
    const findChain = createChainableMock({
      data: rowFor({ status: 'failed', attempts: 2, last_error: 'boom' }),
      error: null,
    });
    const reclaimChain = createChainableMock({
      data: rowFor({ status: 'pending', attempts: 3, last_error: null }),
      error: null,
    });
    callsInOrder(insertChain, findChain, reclaimChain);

    const result = await repo.claim(baseParams);

    expect(result.outcome).toBe('claimed');
    expect(result.message.attempts).toBe(3);
    expect(reclaimChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'pending',
        attempts: 3,
        last_error: null,
      }),
    );
    expect(reclaimChain.eq).toHaveBeenCalledWith('status', 'failed');
  });

  it('treats a lost reclaim race as "ambiguous" rather than retrying', async () => {
    const insertChain = createChainableMock({
      data: null,
      error: { code: '23505', message: 'duplicate key' },
    });
    const findChain = createChainableMock({
      data: rowFor({ status: 'failed', attempts: 1 }),
      error: null,
    });
    // The conditional UPDATE ... WHERE status = 'failed' matches zero rows
    // because a concurrent caller already reclaimed it -- `.single()`
    // reports PGRST116.
    const reclaimChain = createChainableMock({
      data: null,
      error: { code: 'PGRST116', message: 'no rows' },
    });
    const refetchChain = createChainableMock({
      data: rowFor({ status: 'pending', attempts: 2 }),
      error: null,
    });
    callsInOrder(insertChain, findChain, reclaimChain, refetchChain);

    const result = await repo.claim(baseParams);

    expect(result.outcome).toBe('ambiguous');
    expect(result.message.attempts).toBe(2);
  });

  it('throws on a genuine database error during insert', async () => {
    const chain = createChainableMock({
      data: null,
      error: { code: '500', message: 'connection reset' },
    });
    mockSupabaseClient.from.mockReturnValue(chain);

    await expect(repo.claim(baseParams)).rejects.toThrow(
      /Failed to claim outbound message/,
    );
  });
});

describe('OutboundMessageRepository - confirm*', () => {
  let repo: OutboundMessageRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = new OutboundMessageRepository(mockSupabaseClient as any);
  });

  it('confirmSent sets status=sent, external_message_id, and sent_at', async () => {
    const chain: any = { eq: vi.fn() };
    chain.update = vi.fn().mockReturnValue(chain);
    chain.eq.mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    });
    mockSupabaseClient.from.mockReturnValue(chain);

    await repo.confirmSent('fam1', 'om1', '999');

    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'sent', external_message_id: '999' }),
    );
  });

  it('confirmFailed sets status=failed with the error message', async () => {
    const chain: any = { eq: vi.fn() };
    chain.update = vi.fn().mockReturnValue(chain);
    chain.eq.mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    });
    mockSupabaseClient.from.mockReturnValue(chain);

    await repo.confirmFailed('fam1', 'om1', '403 forbidden');

    expect(chain.update).toHaveBeenCalledWith({
      status: 'failed',
      last_error: '403 forbidden',
    });
  });

  it('confirmUnknown sets status=unknown with the error message', async () => {
    const chain: any = { eq: vi.fn() };
    chain.update = vi.fn().mockReturnValue(chain);
    chain.eq.mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    });
    mockSupabaseClient.from.mockReturnValue(chain);

    await repo.confirmUnknown('fam1', 'om1', 'network timeout');

    expect(chain.update).toHaveBeenCalledWith({
      status: 'unknown',
      last_error: 'network timeout',
    });
  });
});

describe('OutboundMessageRepository - findByDedupKey', () => {
  let repo: OutboundMessageRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = new OutboundMessageRepository(mockSupabaseClient as any);
  });

  it('returns the mapped row when found', async () => {
    const chain = createChainableMock({ data: rowFor(), error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await repo.findByDedupKey('fam1', 'facilitator:question:q1');

    expect(result?.id).toBe('om1');
    expect(result?.questionId).toBe('q1');
  });

  it('returns null when no row matches (PGRST116)', async () => {
    const chain = createChainableMock({
      data: null,
      error: { code: 'PGRST116', message: 'no rows' },
    });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await repo.findByDedupKey('fam1', 'nope');

    expect(result).toBeNull();
  });
});
