import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProcessingQueueRepository } from './processing-queue-repository';
import { QueuePriority } from '@sobremesa/shared-types';

// Mock Supabase client
const mockSupabaseClient = {
  from: vi.fn(),
  rpc: vi.fn(),
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
  chain.range = vi.fn().mockReturnValue(chain);
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
      priority: QueuePriority.HIGH,
      queued_at: new Date().toISOString(),
    };

    const chain = createChainableMock({ data: queuedItem, error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    await queueRepo.enqueue('fam1', 'event-1', {
      priority: QueuePriority.HIGH,
    });

    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: QueuePriority.HIGH,
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

describe('ProcessingQueueRepository - dequeueAny', () => {
  let queueRepo: ProcessingQueueRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    queueRepo = new ProcessingQueueRepository(mockSupabaseClient as any);
  });

  it('should return null when queue is empty', async () => {
    mockSupabaseClient.rpc.mockResolvedValue({ data: [], error: null });

    const result = await queueRepo.dequeueAny('worker-1');

    expect(result).toBeNull();
    expect(mockSupabaseClient.rpc).toHaveBeenCalledWith(
      'dequeue_processing_queue_item',
      {
        p_worker_id: 'worker-1',
        p_lock_timeout_ms: 300000,
      },
    );
  });

  it('should lock and return a queued item', async () => {
    const lockedItem = {
      id: 'q1',
      family_id: 'fam1',
      conversation_event_id: 'event-1',
      status: 'processing',
      attempts: 0,
      priority: 100,
      process_after: new Date(Date.now() - 1000).toISOString(), // In the past
      queued_at: new Date().toISOString(),
      locked_at: new Date().toISOString(),
      locked_by: 'worker-1',
    };

    mockSupabaseClient.rpc.mockResolvedValue({
      data: [lockedItem],
      error: null,
    });

    const result = await queueRepo.dequeueAny('worker-1');

    expect(result).not.toBeNull();
    expect(result?.id).toBe('q1');
    expect(result?.status).toBe('processing');
    expect(result?.lockedBy).toBe('worker-1');
  });

  it('should pick up stale processing items', async () => {
    const releasedItem = {
      id: 'q1',
      family_id: 'fam1',
      conversation_event_id: 'event-1',
      status: 'processing',
      attempts: 1,
      priority: 100,
      process_after: new Date(Date.now() - 1000).toISOString(),
      locked_at: new Date().toISOString(),
      locked_by: 'worker-1',
      queued_at: new Date().toISOString(),
    };

    mockSupabaseClient.rpc.mockResolvedValue({
      data: [releasedItem],
      error: null,
    });

    const result = await queueRepo.dequeueAny('worker-1', 300000);

    expect(result).not.toBeNull();
    expect(result?.id).toBe('q1');
    expect(result?.lockedBy).toBe('worker-1');
  });

  it('should surface database dequeue errors', async () => {
    mockSupabaseClient.rpc.mockResolvedValue({
      data: null,
      error: { message: 'function failed' },
    });

    await expect(queueRepo.dequeueAny('worker-1')).rejects.toThrow(
      'Failed to dequeue queue item: function failed',
    );
  });

  it('should call the shared dequeue function with a custom lock timeout', async () => {
    const lockedItem = {
      id: 'q-y',
      family_id: 'family-y',
      conversation_event_id: 'event-y',
      status: 'processing',
      attempts: 0,
      priority: 5,
      process_after: new Date(Date.now() - 1000).toISOString(),
      queued_at: new Date().toISOString(),
      locked_at: new Date().toISOString(),
      locked_by: 'worker-1',
    };
    mockSupabaseClient.rpc.mockResolvedValue({
      data: [lockedItem],
      error: null,
    });

    const result = await queueRepo.dequeueAny('worker-1', 120000);

    expect(result?.id).toBe('q-y');
    expect(result?.familyId).toBe('family-y');
    expect(mockSupabaseClient.rpc).toHaveBeenCalledWith(
      'dequeue_processing_queue_item',
      {
        p_worker_id: 'worker-1',
        p_lock_timeout_ms: 120000,
      },
    );
  });
});

describe('processing queue dequeue migration', () => {
  it('should enforce per-family in-flight exclusion in the database function', () => {
    const migration = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../../../apps/db/supabase/migrations/20260112074715_init_schema.sql',
      ),
      'utf8',
    );

    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION dequeue_processing_queue_item',
    );
    // Per-family exclusivity mechanism: transaction-scoped advisory lock.
    expect(migration).toContain('pg_try_advisory_xact_lock(');
    // Fresh-statement recheck of in-flight state after the advisory lock is held.
    expect(migration).toContain('live.family_id = v_candidate.family_id');
    expect(migration).toContain("live.status = 'processing'");
    // A stale-processing row with no locked_at must still count as in-flight,
    // not silently fall through the exclusion check.
    expect(migration).toContain('live.locked_at IS NULL');
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

describe('ProcessingQueueRepository - getStats', () => {
  let queueRepo: ProcessingQueueRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    queueRepo = new ProcessingQueueRepository(mockSupabaseClient as any);
  });

  it('should query every status and aggregate counts, concurrently', async () => {
    const countsByStatus: Record<string, number> = {
      queued: 3,
      processing: 1,
      done: 42,
      error: 2,
    };

    mockSupabaseClient.from.mockImplementation(() => {
      const chain = createChainableMock({ data: null, error: null });
      chain.eq = vi.fn().mockImplementation((column: string, value: string) => {
        if (column === 'status') {
          chain.then = (resolve: (v: { count: number; error: null }) => void) =>
            resolve({ count: countsByStatus[value], error: null });
        }
        return chain;
      });
      return chain;
    });

    const stats = await queueRepo.getStats('fam1');

    expect(stats).toEqual(countsByStatus);
    expect(mockSupabaseClient.from).toHaveBeenCalledTimes(4);
  });

  it('should throw if any status query errors', async () => {
    const chain = createChainableMock({
      data: null,
      error: { message: 'db unavailable' },
    });
    mockSupabaseClient.from.mockReturnValue(chain);

    await expect(queueRepo.getStats('fam1')).rejects.toThrow(
      'Failed to get queue stats: db unavailable',
    );
  });
});

describe('ProcessingQueueRepository - getErrors', () => {
  let queueRepo: ProcessingQueueRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    queueRepo = new ProcessingQueueRepository(mockSupabaseClient as any);
  });

  it('should cap results with a default limit starting at offset 0', async () => {
    const chain = createChainableMock({ data: [], error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    await queueRepo.getErrors('fam1');

    expect(chain.eq).toHaveBeenCalledWith('status', 'error');
    expect(chain.range).toHaveBeenCalledWith(0, 99);
  });

  it('should respect a custom limit and offset for pagination', async () => {
    const chain = createChainableMock({ data: [], error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    await queueRepo.getErrors('fam1', { limit: 10, offset: 20 });

    expect(chain.range).toHaveBeenCalledWith(20, 29);
  });

  it('should return an empty page for a zero (or negative, clamped-to-zero) limit without querying', async () => {
    const chain = createChainableMock({ data: [], error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    const resultForZero = await queueRepo.getErrors('fam1', { limit: 0 });
    const resultForNegative = await queueRepo.getErrors('fam1', {
      limit: -5,
      offset: -1,
    });

    expect(resultForZero).toEqual([]);
    expect(resultForNegative).toEqual([]);
    // A limit of 0 has no valid `.range()` (it would be inverted) — short
    // circuits before ever touching the DB.
    expect(mockSupabaseClient.from).not.toHaveBeenCalled();
  });

  it('should clamp a negative offset to zero when limit is positive', async () => {
    const chain = createChainableMock({ data: [], error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    await queueRepo.getErrors('fam1', { limit: 10, offset: -1 });

    expect(chain.range).toHaveBeenCalledWith(0, 9);
  });
});

describe('ProcessingQueueRepository - getErrorCount', () => {
  let queueRepo: ProcessingQueueRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    queueRepo = new ProcessingQueueRepository(mockSupabaseClient as any);
  });

  it('should return the exact count of error-status items', async () => {
    const chain = createChainableMock({ data: null, error: null, count: 137 });
    mockSupabaseClient.from.mockReturnValue(chain);

    const count = await queueRepo.getErrorCount('fam1');

    expect(count).toBe(137);
    expect(chain.eq).toHaveBeenCalledWith('status', 'error');
  });

  it('should throw on a database error', async () => {
    const chain = createChainableMock({
      data: null,
      error: { message: 'connection lost' },
    });
    mockSupabaseClient.from.mockReturnValue(chain);

    await expect(queueRepo.getErrorCount('fam1')).rejects.toThrow(
      'Failed to count error queue items: connection lost',
    );
  });
});

describe('ProcessingQueueRepository - requeue', () => {
  let queueRepo: ProcessingQueueRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    queueRepo = new ProcessingQueueRepository(mockSupabaseClient as any);
  });

  it('should return true when a matching error-status item is reset', async () => {
    const chain = createChainableMock({ data: [{ id: 'q1' }], error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await queueRepo.requeue('fam1', 'q1');

    expect(result).toBe(true);
    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'queued', attempts: 0 }),
    );
    expect(chain.eq).toHaveBeenCalledWith('status', 'error');
  });

  it('should return false when no matching error-status item exists', async () => {
    const chain = createChainableMock({ data: [], error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await queueRepo.requeue('fam1', 'missing');

    expect(result).toBe(false);
  });

  it('should throw on a genuine database error', async () => {
    const chain = createChainableMock({
      data: null,
      error: { message: 'connection lost' },
    });
    mockSupabaseClient.from.mockReturnValue(chain);

    await expect(queueRepo.requeue('fam1', 'q1')).rejects.toThrow(
      'Failed to requeue item: connection lost',
    );
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
