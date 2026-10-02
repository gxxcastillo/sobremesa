import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FollowupAgent } from './followup';
import type { ConversationEvent, Family } from '@sobremesa/shared-types';

function makeMessage(
  overrides: Partial<ConversationEvent> = {},
): ConversationEvent {
  return {
    id: 'evt-1',
    familyId: 'fam1',
    sequenceNumber: 10,
    source: 'telegram',
    conversationId: 'conv-1',
    externalEventId: 'ext-1',
    actorExternalId: 'actor-1',
    actorDisplayName: 'Gabriela',
    eventType: 'message',
    contentOriginal: 'Fuimos a Pochomil con toda la familia hace años.',
    occurredAt: new Date('2026-01-01T00:00:00Z'),
    ingestedAt: new Date('2026-01-01T00:00:01Z'),
    ...overrides,
  };
}

function makeFamily(overrides: Partial<Family> = {}): Family {
  return {
    id: 'fam1',
    name: 'Test Family',
    config: {},
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function jsonResponse(body: Record<string, unknown>) {
  return {
    content: JSON.stringify(body),
    usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    model: 'claude-sonnet-5',
  };
}

describe('FollowupAgent.formulate', () => {
  let eventRepo: {
    findById: ReturnType<typeof vi.fn>;
    findRecent: ReturnType<typeof vi.fn>;
  };
  let familyRepo: { findById: ReturnType<typeof vi.fn> };
  let recordContext: { build: ReturnType<typeof vi.fn> };
  let provider: { complete: ReturnType<typeof vi.fn> };
  let logger: Record<
    'debug' | 'info' | 'warn' | 'error',
    ReturnType<typeof vi.fn>
  >;
  let agent: FollowupAgent;

  beforeEach(() => {
    eventRepo = {
      findById: vi.fn().mockResolvedValue(makeMessage()),
      findRecent: vi.fn().mockResolvedValue([]),
    };
    familyRepo = { findById: vi.fn().mockResolvedValue(makeFamily()) };
    recordContext = {
      build: vi
        .fn()
        .mockResolvedValue({ block: '(nothing recorded)', hints: [] }),
    };
    provider = { complete: vi.fn() };
    logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    agent = new FollowupAgent({
      provider: provider as any,
      model: 'claude-sonnet-5',
      eventRepo: eventRepo as any,
      familyRepo: familyRepo as any,
      recordContext: recordContext as any,
      logger: logger as any,
    });
  });

  it('returns a GeneratedQuestion of origin followup when the model asks', async () => {
    provider.complete.mockResolvedValue(
      jsonResponse({
        ask: true,
        question: '¿Con quién ibas a Pochomil?',
        names_used: ['Pochomil'],
        story_context: 'Trips to Pochomil as a child.',
        reason: 'A place from the family past, worth a story.',
      }),
    );

    const result = await agent.formulate({
      familyId: 'fam1',
      domainModel: { conversationEventId: 'evt-1', detectedLanguage: 'es' },
    });

    expect(result.ask).toBe(true);
    expect(result.question).toEqual({
      content: '¿Con quién ibas a Pochomil?',
      language: 'es',
      priority: 50,
      origin: 'followup',
      storyContext: 'Trips to Pochomil as a child.',
    });
    expect(result.namesUsed).toEqual(['Pochomil']);
  });

  it('declines when the model says no, without treating it as a failure', async () => {
    provider.complete.mockResolvedValue(
      jsonResponse({
        ask: false,
        question: '',
        names_used: [],
        story_context: '',
        reason: 'Routine logistics, nothing to invite.',
      }),
    );

    const result = await agent.formulate({
      familyId: 'fam1',
      domainModel: { conversationEventId: 'evt-1' },
    });

    expect(logger.error).not.toHaveBeenCalled();
    expect(result.ask).toBe(false);
    expect(result.question).toBeUndefined();
    expect(result.outcome).toBe('declined');
    expect(result.reason).toBe('Routine logistics, nothing to invite.');
  });

  it('declines without throwing when the response is not valid JSON', async () => {
    provider.complete.mockResolvedValue({
      content: 'not json at all',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      model: 'claude-sonnet-5',
    });

    const result = await agent.formulate({
      familyId: 'fam1',
      domainModel: { conversationEventId: 'evt-1' },
    });

    expect(result.ask).toBe(false);
    expect(result.outcome).toBe('unparseable_response');
    expect(result.reason).toBe('unparseable response');
  });

  it('declines without throwing when the response fails schema validation', async () => {
    provider.complete.mockResolvedValue(
      jsonResponse({ ask: 'yes', question: 123 }),
    );

    const result = await agent.formulate({
      familyId: 'fam1',
      domainModel: { conversationEventId: 'evt-1' },
    });

    expect(result.ask).toBe(false);
    expect(result.outcome).toBe('unparseable_response');
    expect(result.reason).toBe('unparseable response');
  });

  it('declines without throwing when the provider call itself fails', async () => {
    provider.complete.mockRejectedValue(new Error('rate limited'));

    const result = await agent.formulate({
      familyId: 'fam1',
      domainModel: { conversationEventId: 'evt-1' },
    });

    expect(result.ask).toBe(false);
    expect(result.outcome).toBe('provider_error');
    expect(result.reason).toBe('formulation call failed');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        alert: 'followup_provider_error',
        familyId: 'fam1',
        eventId: 'evt-1',
      }),
      'Followup formulation call failed',
    );
  });

  it('declines a name the model used that was never shown to it', async () => {
    provider.complete.mockResolvedValue(
      jsonResponse({
        ask: true,
        question: '¿Qué recuerdas de Xanadú?',
        names_used: ['Xanadú'],
        story_context: 'A place never mentioned.',
        reason: 'Worth asking.',
      }),
    );

    const result = await agent.formulate({
      familyId: 'fam1',
      domainModel: { conversationEventId: 'evt-1' },
    });

    expect(result.ask).toBe(false);
    expect(result.reason).toContain('Xanadú');
    expect(result.question).toBeUndefined();
  });

  it('declines a hallucinated name that is only a substring of something actually shown (regression)', async () => {
    // The message mentions "Mariana", not "Ana" -- a naive substring check
    // on the lowercased prompt would wrongly treat "Ana" as grounded.
    eventRepo.findById.mockResolvedValue(
      makeMessage({ contentOriginal: 'Mariana fue a la playa con su prima.' }),
    );
    provider.complete.mockResolvedValue(
      jsonResponse({
        ask: true,
        question: '¿Qué recuerdas de Ana en la playa?',
        names_used: ['Ana'],
        story_context: 'A beach trip.',
        reason: 'Worth asking.',
      }),
    );

    const result = await agent.formulate({
      familyId: 'fam1',
      domainModel: { conversationEventId: 'evt-1' },
    });

    expect(result.ask).toBe(false);
    expect(result.reason).toContain('Ana');
  });

  it('declines when the model asks but writes no question text', async () => {
    provider.complete.mockResolvedValue(
      jsonResponse({
        ask: true,
        question: '   ',
        names_used: [],
        story_context: '',
        reason: 'Worth asking.',
      }),
    );

    const result = await agent.formulate({
      familyId: 'fam1',
      domainModel: { conversationEventId: 'evt-1' },
    });

    expect(result.ask).toBe(false);
    expect(result.reason).toBe('ask=true with empty question text');
  });

  it('declines cleanly when the source message has no text', async () => {
    eventRepo.findById.mockResolvedValue(
      makeMessage({ contentOriginal: undefined }),
    );

    const result = await agent.formulate({
      familyId: 'fam1',
      domainModel: { conversationEventId: 'evt-1' },
    });

    expect(result.ask).toBe(false);
    expect(result.reason).toBe('source message has no text');
    expect(provider.complete).not.toHaveBeenCalled();
  });

  describe('language fallback', () => {
    it("uses the domain model's detected language when present", async () => {
      provider.complete.mockResolvedValue(
        jsonResponse({
          ask: true,
          question: 'Q',
          names_used: [],
          story_context: '',
          reason: 'r',
        }),
      );

      const result = await agent.formulate({
        familyId: 'fam1',
        domainModel: { conversationEventId: 'evt-1', detectedLanguage: 'es' },
      });

      expect(result.question?.language).toBe('es');
    });

    it("falls back to the family's primary language when detection is absent", async () => {
      familyRepo.findById.mockResolvedValue(
        makeFamily({ config: { defaultLanguage: 'es' } }),
      );
      provider.complete.mockResolvedValue(
        jsonResponse({
          ask: true,
          question: 'Q',
          names_used: [],
          story_context: '',
          reason: 'r',
        }),
      );

      const result = await agent.formulate({
        familyId: 'fam1',
        domainModel: { conversationEventId: 'evt-1' },
      });

      expect(result.question?.language).toBe('es');
    });

    it('falls back to the default language when neither is available', async () => {
      familyRepo.findById.mockResolvedValue(makeFamily({ config: {} }));
      provider.complete.mockResolvedValue(
        jsonResponse({
          ask: true,
          question: 'Q',
          names_used: [],
          story_context: '',
          reason: 'r',
        }),
      );

      const result = await agent.formulate({
        familyId: 'fam1',
        domainModel: { conversationEventId: 'evt-1' },
      });

      expect(result.question?.language).toBe('en');
    });

    it('an unsupported detected language (e.g. Portuguese, from import) falls back rather than passing through', async () => {
      provider.complete.mockResolvedValue(
        jsonResponse({
          ask: true,
          question: 'Q',
          names_used: [],
          story_context: '',
          reason: 'r',
        }),
      );

      const result = await agent.formulate({
        familyId: 'fam1',
        domainModel: { conversationEventId: 'evt-1', detectedLanguage: 'pt' },
      });

      expect(result.question?.language).toBe('en');
    });
  });

  it('sends preceding messages oldest-first even though findRecent returns them newest-first', async () => {
    eventRepo.findRecent.mockResolvedValue([
      makeMessage({ id: 'evt-0-newer', contentOriginal: 'newer' }),
      makeMessage({ id: 'evt-0-older', contentOriginal: 'older' }),
    ]);
    provider.complete.mockResolvedValue(
      jsonResponse({
        ask: false,
        question: '',
        names_used: [],
        story_context: '',
        reason: 'r',
      }),
    );

    await agent.formulate({
      familyId: 'fam1',
      domainModel: { conversationEventId: 'evt-1' },
    });

    const sentPrompt = provider.complete.mock.calls[0][0].messages[0]
      .content as string;
    expect(sentPrompt.indexOf('older')).toBeLessThan(
      sentPrompt.indexOf('newer'),
    );
  });

  it('never sends a temperature (Sonnet 5 rejects it)', async () => {
    provider.complete.mockResolvedValue(
      jsonResponse({
        ask: false,
        question: '',
        names_used: [],
        story_context: '',
        reason: 'r',
      }),
    );

    await agent.formulate({
      familyId: 'fam1',
      domainModel: { conversationEventId: 'evt-1' },
    });

    expect(provider.complete.mock.calls[0][0].temperature).toBeUndefined();
  });
});
