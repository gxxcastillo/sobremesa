import { describe, expect, it } from 'vitest';
import { buildUserMessage } from './prompt-builder';
import type { ScribeContext } from './types';

function baseContext(overrides?: Partial<ScribeContext>): ScribeContext {
  return {
    recentMessages: [],
    recentImages: [],
    ...overrides,
  };
}

describe('buildUserMessage', () => {
  it('prints recent message context oldest first with compact timestamps', () => {
    const context = baseContext({
      recentMessages: [
        {
          senderName: 'Ana',
          content: 'Maria moved to Managua.',
          occurredAt: new Date('2026-06-30T14:22:00Z'),
        },
        {
          senderName: 'Luis',
          content: 'She started school there.',
          occurredAt: new Date('2026-06-30T15:05:00Z'),
        },
      ],
    });

    const message = buildUserMessage(
      'That was before the twins were born.',
      'Sofia',
      context,
      new Date('2026-07-01T00:00:00Z'),
      'UTC',
    );

    expect(message).toContain('CONTEXT (oldest first):');
    expect(message).toContain('[Jun 30 14:22] Ana: Maria moved to Managua.');
    expect(message).toContain('[Jun 30 15:05] Luis: She started school there.');
    expect(message.indexOf('Ana:')).toBeLessThan(message.indexOf('Luis:'));
  });

  it('prints reply and answered-question blocks before the current message', () => {
    const context = baseContext({
      replyToMessage: {
        senderName: 'Carlos',
        content: 'The wedding was in 1982.',
        occurredAt: new Date('2026-06-30T14:22:00Z'),
      },
      answeredQuestion: {
        askedByName: 'Facilitator',
        content: 'What city was the wedding in?',
      },
    });

    const message = buildUserMessage(
      'Granada.',
      'Sofia',
      context,
      new Date('2026-07-01T00:00:00Z'),
      'UTC',
    );

    expect(message).toContain('IN REPLY TO Carlos: The wedding was in 1982.');
    expect(message).toContain(
      'IN REPLY TO QUESTION (asked by Facilitator): What city was the wedding in?',
    );
    expect(message.indexOf('IN REPLY TO Carlos:')).toBeLessThan(
      message.indexOf('MESSAGE from Sofia:'),
    );
    expect(
      message.indexOf('IN REPLY TO QUESTION (asked by Facilitator):'),
    ).toBeLessThan(message.indexOf('MESSAGE from Sofia:'));
  });
});
