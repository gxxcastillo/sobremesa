import { describe, expect, it, vi } from 'vitest';
import { buildScribeContext, convertToScribeContext } from './context-builder';
import type { ConversationEventRepository } from '@sobremesa/database';

describe('convertToScribeContext', () => {
  it('preserves explicit reply and answered-question context', () => {
    const context = convertToScribeContext({
      recentMessages: [],
      replyToMessage: {
        id: 'event-1',
        content: 'The wedding was in 1982.',
        senderName: 'Carlos',
        occurredAt: new Date('2026-06-30T14:22:00Z'),
      },
      answeredQuestion: {
        id: 'question-1',
        content: 'Where was the wedding?',
        askedByName: 'Facilitator',
      },
      recentImages: [],
    });

    expect(context.replyToMessage).toEqual({
      content: 'The wedding was in 1982.',
      senderName: 'Carlos',
      occurredAt: new Date('2026-06-30T14:22:00Z'),
    });
    expect(context.answeredQuestion).toEqual({
      content: 'Where was the wedding?',
      askedByName: 'Facilitator',
    });
  });
});

describe('buildScribeContext', () => {
  it('returns DB-fetched recent messages oldest first and includes reply context', async () => {
    const eventRepo = {
      findRecent: vi.fn().mockResolvedValue([
        {
          id: 'event-new',
          contentOriginal: 'Newest',
          actorDisplayName: 'Nina',
          occurredAt: new Date('2026-01-03T12:00:00Z'),
        },
        {
          id: 'event-old',
          contentOriginal: 'Oldest',
          actorDisplayName: 'Olivia',
          occurredAt: new Date('2026-01-01T12:00:00Z'),
        },
      ]),
      findByExternalId: vi.fn().mockResolvedValue({
        id: 'reply-event',
        contentOriginal: 'The wedding was in 1982.',
        actorDisplayName: 'Carlos',
        occurredAt: new Date('2026-01-01T13:00:00Z'),
      }),
    };

    const context = await buildScribeContext(
      'family-1',
      'conv-1',
      {
        eventRepo: eventRepo as unknown as ConversationEventRepository,
      },
      {
        beforeSequenceNumber: 10,
        replyTo: {
          source: 'telegram',
          externalEventId: '42',
        },
      },
    );

    expect(eventRepo.findRecent).toHaveBeenCalledWith(
      'family-1',
      'conv-1',
      30,
      false,
      10,
    );
    expect(context.recentMessages.map((msg) => msg.content)).toEqual([
      'Oldest',
      'Newest',
    ]);
    expect(context.replyToMessage).toEqual({
      content: 'The wedding was in 1982.',
      senderName: 'Carlos',
      occurredAt: new Date('2026-01-01T13:00:00Z'),
    });
  });
});
