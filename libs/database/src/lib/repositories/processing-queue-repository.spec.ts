import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProcessingQueueRepository } from './processing-queue-repository';

// Mock Supabase client
const mockSupabaseClient = {
  from: vi.fn(),
};

// Helper to create chainable mock
const createChainableMock = (finalResult: { data: any; error: any }) => {
  const chain: any = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.insert = vi.fn().mockReturnValue(chain);
  chain.update = vi.fn().mockReturnValue(chain);
  chain.delete = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.neq = vi.fn().mockReturnValue(chain);
  chain.lt = vi.fn().mockReturnValue(chain);
  chain.lte = vi.fn().mockReturnValue(chain);
  chain.in = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue(finalResult);
  // For operations that don't call single()
  chain.then = (resolve: (value: { data: unknown; error: unknown }) => void) =>
    resolve(finalResult);
  return chain;
};

describe('ProcessingQueueRepository - enqueue', () => {
  let queueRepo: ProcessingQueueRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    queueRepo = new ProcessingQueueRepository(mockSupabaseClient as any);
  });

  it('should enqueue a new event with default priority', async () => {
    const queuedItem = {
      id: 'q1',
      family_id: 'fam1',
      conversation_event_id: 'event-1',
      status: 'queued',
      attempts: 0,
      priority: 5, // QueuePriority.NORMAL
      queued_at: new Date().toISOString(),
    };

    const chain = createChainableMock({ data: queuedItem, error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await queueRepo.enqueue('fam1', 'event-1');

    expect(result.conversationEventId).toBe('event-1');
    expect(result.status).toBe('queued');
    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        family_id: 'fam1',
        conversation_event_id: 'event-1',
        status: 'queued',
        attempts: 0,
        priority: 5, // QueuePriority.NORMAL
      }),
    );
  });

  it('should return existing item on unique constraint violation', async () => {
    const existingItem = {
      id: 'q1',
      family_id: 'fam1',
      conversation_event_id: 'event-1',
      status: 'queued',
      attempts: 0,
      priority: 100,
      queued_at: new Date().toISOString(),
    };

    // First call fails with unique constraint
    const insertChain = createChainableMock({
      data: null,
      error: { code: '23505', message: 'Unique violation' },
    });

    // Second call finds existing
    const findChain = createChainableMock({ data: existingItem, error: null });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? insertChain : findChain;
    });

    const result = await queueRepo.enqueue('fam1', 'event-1');

    expect(result.id).toBe('q1');
    expect(result.conversationEventId).toBe('event-1');
  });

  it('should support custom priority', async () => {
    const queuedItem = {
      id: 'q1',
      family_id: 'fam1',
      conversation_event_id: 'event-1',
      status: 'queued',
      attempts: 0,
      priority: 50,
      queued_at: new Date().toISOString(),
    };

    const chain = createChainableMock({ data: queuedItem, error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    await queueRepo.enqueue('fam1', 'event-1', { priority: 50 });

    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: 50,
      }),
    );
  });
});

describe('ProcessingQueueRepository - fail', () => {
  let queueRepo: ProcessingQueueRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    queueRepo = new ProcessingQueueRepository(mockSupabaseClient as any);
  });

  it('should requeue item on first failure (attempts < maxRetries)', async () => {
    // First call: get current attempts
    const fetchChain = createChainableMock({
      data: { attempts: 0 },
      error: null,
    });
    // Second call: update status
    const updateChain = createChainableMock({ data: null, error: null });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? fetchChain : updateChain;
    });

    await queueRepo.fail('fam1', 'q1', 'Test error');

    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'queued', // Should be requeued, not error
        attempts: 1,
        last_error: 'Test error',
        locked_at: null,
        locked_by: null,
      }),
    );
  });

  it('should requeue item on second failure (attempts < maxRetries)', async () => {
    const fetchChain = createChainableMock({
      data: { attempts: 1 },
      error: null,
    });
    const updateChain = createChainableMock({ data: null, error: null });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? fetchChain : updateChain;
    });

    await queueRepo.fail('fam1', 'q1', 'Test error');

    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'queued', // Should still be requeued
        attempts: 2,
      }),
    );
  });

  it('should mark as error on third failure (attempts >= maxRetries)', async () => {
    const fetchChain = createChainableMock({
      data: { attempts: 2 },
      error: null,
    });
    const updateChain = createChainableMock({ data: null, error: null });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? fetchChain : updateChain;
    });

    await queueRepo.fail('fam1', 'q1', 'Test error');

    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error', // Should be permanently failed
        attempts: 3,
        last_error: 'Test error',
      }),
    );
  });

  it('should respect custom maxRetries parameter', async () => {
    // With maxRetries=5, attempts=4 should still requeue
    const fetchChain = createChainableMock({
      data: { attempts: 4 },
      error: null,
    });
    const updateChain = createChainableMock({ data: null, error: null });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? fetchChain : updateChain;
    });

    await queueRepo.fail('fam1', 'q1', 'Test error', 5);

    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error', // 4+1 = 5 >= maxRetries(5), so error
        attempts: 5,
      }),
    );
  });

  it('should handle null attempts gracefully', async () => {
    // Edge case: attempts is null/undefined
    const fetchChain = createChainableMock({
      data: { attempts: null },
      error: null,
    });
    const updateChain = createChainableMock({ data: null, error: null });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? fetchChain : updateChain;
    });

    await queueRepo.fail('fam1', 'q1', 'Test error');

    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'queued',
        attempts: 1, // (null || 0) + 1 = 1
      }),
    );
  });

  it('should clear lock fields on failure', async () => {
    const fetchChain = createChainableMock({
      data: { attempts: 0 },
      error: null,
    });
    const updateChain = createChainableMock({ data: null, error: null });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? fetchChain : updateChain;
    });

    await queueRepo.fail('fam1', 'q1', 'Test error');

    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        locked_at: null,
        locked_by: null,
      }),
    );
  });
});

describe('ProcessingQueueRepository - dequeue', () => {
  let queueRepo: ProcessingQueueRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    queueRepo = new ProcessingQueueRepository(mockSupabaseClient as any);
  });

  it('should return null when queue is empty', async () => {
    // Both queries return empty
    const emptyChain = createChainableMock({ data: [], error: null });
    mockSupabaseClient.from.mockReturnValue(emptyChain);

    const result = await queueRepo.dequeue('fam1', 'worker-1');

    expect(result).toBeNull();
  });

  it('should lock and return queued item', async () => {
    const queuedItem = {
      id: 'q1',
      family_id: 'fam1',
      conversation_event_id: 'event-1',
      status: 'queued',
      attempts: 0,
      priority: 100,
      process_after: new Date(Date.now() - 1000).toISOString(), // In the past
      queued_at: new Date().toISOString(),
    };

    const lockedItem = {
      ...queuedItem,
      status: 'processing',
      locked_at: new Date().toISOString(),
      locked_by: 'worker-1',
    };

    // First call: select queued items
    const selectChain = createChainableMock({
      data: [queuedItem],
      error: null,
    });
    // Second call: update to lock
    const updateChain = createChainableMock({
      data: [lockedItem],
      error: null,
    });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? selectChain : updateChain;
    });

    const result = await queueRepo.dequeue('fam1', 'worker-1');

    expect(result).not.toBeNull();
    expect(result?.id).toBe('q1');
    expect(result?.status).toBe('processing');
    expect(result?.lockedBy).toBe('worker-1');
  });

  it('should pick up stale processing items', async () => {
    const staleItem = {
      id: 'q1',
      family_id: 'fam1',
      conversation_event_id: 'event-1',
      status: 'processing',
      attempts: 1,
      priority: 100,
      process_after: new Date(Date.now() - 1000).toISOString(),
      locked_at: new Date(Date.now() - 400000).toISOString(), // 6+ minutes ago (stale)
      locked_by: 'dead-worker',
      queued_at: new Date().toISOString(),
    };

    const releasedItem = {
      ...staleItem,
      locked_at: new Date().toISOString(),
      locked_by: 'worker-1',
    };

    // First call: select queued items (empty)
    const emptyChain = createChainableMock({ data: [], error: null });
    // Second call: select stale processing items
    const staleChain = createChainableMock({ data: [staleItem], error: null });
    // Third call: update to re-lock
    const updateChain = createChainableMock({
      data: [releasedItem],
      error: null,
    });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return emptyChain;
      if (callCount === 2) return staleChain;
      return updateChain;
    });

    const result = await queueRepo.dequeue('fam1', 'worker-1');

    expect(result).not.toBeNull();
    expect(result?.id).toBe('q1');
    expect(result?.lockedBy).toBe('worker-1');
  });
});

describe('ProcessingQueueRepository - completeMany', () => {
  let queueRepo: ProcessingQueueRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    queueRepo = new ProcessingQueueRepository(mockSupabaseClient as any);
  });

  it('should mark multiple items as done', async () => {
    const chain = createChainableMock({ data: null, error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    await queueRepo.completeMany('fam1', ['q1', 'q2', 'q3']);

    expect(chain.update).toHaveBeenCalledWith({ status: 'done' });
    expect(chain.in).toHaveBeenCalledWith('id', ['q1', 'q2', 'q3']);
  });

  it('should do nothing for empty array', async () => {
    await queueRepo.completeMany('fam1', []);

    expect(mockSupabaseClient.from).not.toHaveBeenCalled();
  });
});

describe('ProcessingQueueRepository - clearCompleted', () => {
  let queueRepo: ProcessingQueueRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    queueRepo = new ProcessingQueueRepository(mockSupabaseClient as any);
  });

  it('should delete completed items older than threshold', async () => {
    const deletedItems = [{ id: 'q1' }, { id: 'q2' }];

    const chain = createChainableMock({ data: deletedItems, error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await queueRepo.clearCompleted('fam1', 7);

    expect(result).toBe(2);
    expect(chain.delete).toHaveBeenCalled();
    expect(chain.eq).toHaveBeenCalledWith('family_id', 'fam1');
    expect(chain.eq).toHaveBeenCalledWith('status', 'done');
  });

  it('should return 0 when no items deleted', async () => {
    const chain = createChainableMock({ data: [], error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await queueRepo.clearCompleted('fam1', 7);

    expect(result).toBe(0);
  });
});
