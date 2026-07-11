import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageQueue, type MessageHandler } from './message-queue';

const mockRepository = {
  enqueue: vi.fn(),
  dequeueAny: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  getStats: vi.fn(),
};

const silentLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const FAMILY_ID = 'family-1';

const baseItem = {
  id: 'queue-item-1',
  familyId: FAMILY_ID,
  conversationEventId: 'event-1',
  status: 'processing' as const,
  attempts: 0,
  priority: 5,
  queuedAt: new Date('2026-01-01T00:00:00Z'),
  processAfter: new Date('2026-01-01T00:00:00Z'),
};

function createQueue(
  overrides: Partial<{
    queueOptions: {
      maxRetries?: number;
      retryDelayMs?: number;
      lockTimeoutMs?: number;
    };
    pollIntervalMs: number;
  }> = {},
): MessageQueue {
  return new MessageQueue({
    repository: mockRepository as any,
    logger: silentLogger as any,
    queueOptions: overrides.queueOptions,
    pollIntervalMs: overrides.pollIntervalMs,
  });
}

describe('MessageQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('processOne', () => {
    it('completes the item exactly once on handler success', async () => {
      mockRepository.dequeueAny.mockResolvedValue({ ...baseItem });
      const handler: MessageHandler = vi
        .fn()
        .mockResolvedValue({ success: true, duration: 5 });
      const queue = createQueue();
      queue.setHandler(handler);

      const processed = await queue.processOne();

      expect(processed).toBe(true);
      expect(mockRepository.complete).toHaveBeenCalledTimes(1);
      expect(mockRepository.complete).toHaveBeenCalledWith(
        FAMILY_ID,
        baseItem.id,
      );
      expect(mockRepository.fail).not.toHaveBeenCalled();
    });

    it('returns false without touching complete/fail when the queue is empty', async () => {
      mockRepository.dequeueAny.mockResolvedValue(null);
      const queue = createQueue();
      queue.setHandler(vi.fn());

      const processed = await queue.processOne();

      expect(processed).toBe(false);
      expect(mockRepository.complete).not.toHaveBeenCalled();
      expect(mockRepository.fail).not.toHaveBeenCalled();
    });

    it('forwards the configured lockTimeoutMs to dequeueAny so stale-locked items become eligible again', async () => {
      mockRepository.dequeueAny.mockResolvedValue(null);
      const queue = createQueue({ queueOptions: { lockTimeoutMs: 45000 } });
      queue.setHandler(vi.fn());

      await queue.processOne();

      expect(mockRepository.dequeueAny).toHaveBeenCalledWith(
        expect.any(String),
        45000,
      );
    });

    it('retries on failure and dead-letters (logging at ERROR) once maxRetries is reached', async () => {
      mockRepository.dequeueAny.mockResolvedValue({ ...baseItem });
      mockRepository.fail
        .mockResolvedValueOnce('queued')
        .mockResolvedValueOnce('queued')
        .mockResolvedValueOnce('error');
      const handler: MessageHandler = vi
        .fn()
        .mockResolvedValue({ success: false, error: 'boom', duration: 1 });
      const queue = createQueue({ queueOptions: { maxRetries: 3 } });
      queue.setHandler(handler);

      await queue.processOne();
      await queue.processOne();
      await queue.processOne();

      expect(mockRepository.fail).toHaveBeenCalledTimes(3);
      expect(mockRepository.complete).not.toHaveBeenCalled();
      expect(silentLogger.warn).toHaveBeenCalledTimes(2);
      expect(silentLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ itemId: baseItem.id }),
        'Queue item dead-lettered after max retries',
      );
    });

    it('fails the item and dead-letters the same way when the handler throws', async () => {
      mockRepository.dequeueAny.mockResolvedValue({ ...baseItem });
      mockRepository.fail.mockResolvedValueOnce('error');
      const handler: MessageHandler = vi
        .fn()
        .mockRejectedValue(new Error('handler exploded'));
      const queue = createQueue({ queueOptions: { maxRetries: 1 } });
      queue.setHandler(handler);

      const processed = await queue.processOne();

      expect(processed).toBe(true);
      expect(mockRepository.fail).toHaveBeenCalledWith(
        FAMILY_ID,
        baseItem.id,
        'handler exploded',
        1,
        5000, // default retryDelayMs
      );
      expect(silentLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ itemId: baseItem.id }),
        'Queue item dead-lettered after max retries',
      );
    });

    it('forwards the configured retryDelayMs to fail() so retries are spaced out', async () => {
      mockRepository.dequeueAny.mockResolvedValue({ ...baseItem });
      mockRepository.fail.mockResolvedValueOnce('queued');
      const handler: MessageHandler = vi
        .fn()
        .mockResolvedValue({ success: false, error: 'boom', duration: 1 });
      const queue = createQueue({ queueOptions: { retryDelayMs: 9000 } });
      queue.setHandler(handler);

      await queue.processOne();

      expect(mockRepository.fail).toHaveBeenCalledWith(
        FAMILY_ID,
        baseItem.id,
        'boom',
        expect.any(Number),
        9000,
      );
    });
  });

  describe('poll loop', () => {
    it('polls again at pollIntervalMs when the queue is empty, without tight-looping', async () => {
      vi.useFakeTimers();
      mockRepository.dequeueAny.mockResolvedValue(null);
      const queue = createQueue({ pollIntervalMs: 1000 });
      queue.setHandler(vi.fn());

      await queue.start();
      expect(mockRepository.dequeueAny).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(mockRepository.dequeueAny).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(mockRepository.dequeueAny).toHaveBeenCalledTimes(2);

      queue.stop();
    });

    it('polls again immediately after processing an item successfully', async () => {
      vi.useFakeTimers();
      mockRepository.dequeueAny.mockResolvedValue({ ...baseItem });
      mockRepository.complete.mockResolvedValue(undefined);
      const queue = createQueue({ pollIntervalMs: 1000 });
      queue.setHandler(
        vi.fn().mockResolvedValue({ success: true, duration: 1 }),
      );

      await queue.start();
      expect(mockRepository.dequeueAny).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(0);
      expect(mockRepository.dequeueAny).toHaveBeenCalledTimes(2);

      queue.stop();
    });

    it('stop() prevents further polling', async () => {
      vi.useFakeTimers();
      mockRepository.dequeueAny.mockResolvedValue(null);
      const queue = createQueue({ pollIntervalMs: 1000 });
      queue.setHandler(vi.fn());

      await queue.start();
      queue.stop();
      await vi.advanceTimersByTimeAsync(5000);

      expect(mockRepository.dequeueAny).toHaveBeenCalledTimes(1);
    });
  });
});
