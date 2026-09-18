import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramError } from 'telegraf';
import { MessageDeliveryError } from '@sobremesa/shared-types';
import type {
  ClaimOutboundMessageParams,
  ClaimOutboundMessageResult,
  OutboundMessage,
} from '@sobremesa/shared-types';
import { BotManager } from './bot-manager';

/**
 * In-memory stand-in for `OutboundMessageRepository` -- same claim/confirm
 * contract, no Supabase client. `seed()` lets a test start from an
 * already-existing ledger row (simulating a prior claim from an earlier
 * process/pass), matching how `bot-manager.spec.ts` is meant to test the
 * claim branches without touching the real repository's SQL.
 */
class InMemoryOutboundMessageRepo {
  private rows = new Map<string, OutboundMessage>();
  private seq = 0;

  seed(row: Partial<OutboundMessage> & { familyId: string; dedupKey: string }) {
    const full: OutboundMessage = {
      id: row.id ?? `seed-${++this.seq}`,
      familyId: row.familyId,
      dedupKey: row.dedupKey,
      role: row.role ?? 'test',
      chatId: row.chatId ?? 'chat1',
      content: row.content ?? 'seeded content',
      status: row.status ?? 'pending',
      sendAttemptedAt: row.sendAttemptedAt ?? new Date(),
      externalMessageId: row.externalMessageId,
      conversationEventId: row.conversationEventId,
      questionId: row.questionId,
      attempts: row.attempts ?? 1,
      lastError: row.lastError,
      createdAt: row.createdAt ?? new Date(),
      sentAt: row.sentAt,
    };
    this.rows.set(this.key(row.familyId, row.dedupKey), full);
    return full;
  }

  async claim(
    params: ClaimOutboundMessageParams,
  ): Promise<ClaimOutboundMessageResult> {
    const key = this.key(params.familyId, params.dedupKey);
    const existing = this.rows.get(key);

    if (!existing) {
      const row: OutboundMessage = {
        id: `row-${++this.seq}`,
        familyId: params.familyId,
        dedupKey: params.dedupKey,
        role: params.role,
        chatId: params.chatId,
        content: params.content,
        status: 'pending',
        sendAttemptedAt: new Date(),
        conversationEventId: params.conversationEventId,
        questionId: params.questionId,
        attempts: 1,
        createdAt: new Date(),
      };
      this.rows.set(key, row);
      return { outcome: 'claimed', message: row };
    }

    if (existing.status === 'sent') {
      return { outcome: 'duplicate', message: existing };
    }

    if (existing.status === 'failed') {
      existing.status = 'pending';
      existing.content = params.content;
      existing.chatId = params.chatId;
      existing.sendAttemptedAt = new Date();
      existing.attempts += 1;
      existing.lastError = undefined;
      return { outcome: 'claimed', message: existing };
    }

    // 'pending' or 'unknown': a prior claim's outcome isn't known yet.
    return { outcome: 'ambiguous', message: existing };
  }

  async confirmSent(
    familyId: string,
    id: string,
    externalMessageId?: string,
  ): Promise<void> {
    const row = this.findById(id);
    if (row) {
      row.status = 'sent';
      row.externalMessageId = externalMessageId;
      row.sentAt = new Date();
    }
  }

  async confirmFailed(
    familyId: string,
    id: string,
    errorMessage: string,
  ): Promise<void> {
    const row = this.findById(id);
    if (row) {
      row.status = 'failed';
      row.lastError = errorMessage;
    }
  }

  async confirmUnknown(
    familyId: string,
    id: string,
    errorMessage: string,
  ): Promise<void> {
    const row = this.findById(id);
    if (row) {
      row.status = 'unknown';
      row.lastError = errorMessage;
    }
  }

  async findByDedupKey(
    familyId: string,
    dedupKey: string,
  ): Promise<OutboundMessage | null> {
    return this.rows.get(this.key(familyId, dedupKey)) ?? null;
  }

  private findById(id: string): OutboundMessage | undefined {
    for (const row of this.rows.values()) {
      if (row.id === id) return row;
    }
    return undefined;
  }

  private key(familyId: string, dedupKey: string): string {
    return `${familyId}:${dedupKey}`;
  }
}

function createTelegramError(code: number): TelegramError {
  return new TelegramError({ error_code: code, description: `error ${code}` });
}

function createBotManager(repo: InMemoryOutboundMessageRepo) {
  const manager = new BotManager({
    token: 'test-token',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dbClient: {} as any,
    studioUrl: 'https://studio.example.com',
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outboundMessageRepo: repo as any,
    messageSpacing: { minSecondsBetweenMessages: 0 },
  });
  return manager;
}

describe('BotManager.sendMessage', () => {
  let repo: InMemoryOutboundMessageRepo;
  let manager: BotManager;
  let sendMessageMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    repo = new InMemoryOutboundMessageRepo();
    manager = createBotManager(repo);
    sendMessageMock = vi.fn();
    manager.getBot().telegram.sendMessage = sendMessageMock;
  });

  it('resolves { status: "sent", messageId } on a successful send', async () => {
    sendMessageMock.mockResolvedValue({ message_id: 42 });

    const outcome = await manager.sendMessage('facilitator', {
      chatId: 'chat1',
      text: 'hello',
    });

    expect(outcome).toEqual({ status: 'sent', messageId: 42 });
  });

  it('throws MessageDeliveryError on a definitive 4xx failure, without a dedup key', async () => {
    sendMessageMock.mockRejectedValue(createTelegramError(403));

    await expect(
      manager.sendMessage('facilitator', { chatId: 'chat1', text: 'hello' }),
    ).rejects.toThrow(MessageDeliveryError);
  });

  it('resolves { status: "unconfirmed" } on an ambiguous network/5xx failure, never throwing', async () => {
    sendMessageMock.mockRejectedValue(new Error('socket hang up'));

    const outcome = await manager.sendMessage('facilitator', {
      chatId: 'chat1',
      text: 'hello',
    });

    expect(outcome).toEqual({ status: 'unconfirmed' });
  });

  it('resolves { status: "unconfirmed" } on a Telegram 5xx failure, never throwing', async () => {
    sendMessageMock.mockRejectedValue(createTelegramError(500));

    const outcome = await manager.sendMessage('facilitator', {
      chatId: 'chat1',
      text: 'hello',
    });

    expect(outcome).toEqual({ status: 'unconfirmed' });
  });

  describe('with a dedup key', () => {
    const dedup = { familyId: 'fam1', key: 'facilitator:question:q1' };

    it('claims fresh, sends, and confirms "sent" in the ledger', async () => {
      sendMessageMock.mockResolvedValue({ message_id: 99 });

      const outcome = await manager.sendMessage(
        'facilitator',
        { chatId: 'chat1', text: 'hello' },
        { dedup },
      );

      expect(outcome).toEqual({ status: 'sent', messageId: 99 });
      const row = await repo.findByDedupKey(dedup.familyId, dedup.key);
      expect(row?.status).toBe('sent');
      expect(row?.externalMessageId).toBe('99');
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
    });

    it('returns "duplicate" with the recorded message id and does not resend', async () => {
      repo.seed({
        familyId: dedup.familyId,
        dedupKey: dedup.key,
        status: 'sent',
        externalMessageId: '777',
      });

      const outcome = await manager.sendMessage(
        'facilitator',
        { chatId: 'chat1', text: 'hello' },
        { dedup },
      );

      expect(outcome).toEqual({ status: 'duplicate', messageId: 777 });
      expect(sendMessageMock).not.toHaveBeenCalled();
    });

    it('returns "unconfirmed" without resending when a prior claim is still pending', async () => {
      repo.seed({
        familyId: dedup.familyId,
        dedupKey: dedup.key,
        status: 'pending',
      });

      const outcome = await manager.sendMessage(
        'facilitator',
        { chatId: 'chat1', text: 'hello' },
        { dedup },
      );

      expect(outcome).toEqual({ status: 'unconfirmed' });
      expect(sendMessageMock).not.toHaveBeenCalled();
    });

    it('returns "unconfirmed" without resending when a prior claim is unknown', async () => {
      repo.seed({
        familyId: dedup.familyId,
        dedupKey: dedup.key,
        status: 'unknown',
      });

      const outcome = await manager.sendMessage(
        'facilitator',
        { chatId: 'chat1', text: 'hello' },
        { dedup },
      );

      expect(outcome).toEqual({ status: 'unconfirmed' });
      expect(sendMessageMock).not.toHaveBeenCalled();
    });

    it('reclaims a failed row and sends again', async () => {
      repo.seed({
        familyId: dedup.familyId,
        dedupKey: dedup.key,
        status: 'failed',
        attempts: 1,
        lastError: 'boom',
      });
      sendMessageMock.mockResolvedValue({ message_id: 55 });

      const outcome = await manager.sendMessage(
        'facilitator',
        { chatId: 'chat1', text: 'hello' },
        { dedup },
      );

      expect(outcome).toEqual({ status: 'sent', messageId: 55 });
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const row = await repo.findByDedupKey(dedup.familyId, dedup.key);
      expect(row?.attempts).toBe(2);
    });

    it('confirms "failed" in the ledger and throws on a 4xx failure', async () => {
      sendMessageMock.mockRejectedValue(createTelegramError(400));

      await expect(
        manager.sendMessage(
          'facilitator',
          { chatId: 'chat1', text: 'hello' },
          { dedup },
        ),
      ).rejects.toThrow(MessageDeliveryError);

      const row = await repo.findByDedupKey(dedup.familyId, dedup.key);
      expect(row?.status).toBe('failed');
    });

    it('confirms "unknown" in the ledger and returns unconfirmed on a network failure', async () => {
      sendMessageMock.mockRejectedValue(new Error('ETIMEDOUT'));

      const outcome = await manager.sendMessage(
        'facilitator',
        { chatId: 'chat1', text: 'hello' },
        { dedup },
      );

      expect(outcome).toEqual({ status: 'unconfirmed' });
      const row = await repo.findByDedupKey(dedup.familyId, dedup.key);
      expect(row?.status).toBe('unknown');
    });
  });
});
