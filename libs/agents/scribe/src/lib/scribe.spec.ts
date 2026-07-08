import { describe, expect, it } from 'vitest';
import type {
  AICompletionRequest,
  AICompletionResponse,
  AIProvider,
} from '@sobremesa/ai-provider';
import type {
  ConversationEventRepository,
  FamilyRepository,
  ImageRepository,
} from '@sobremesa/database';
import type { ConversationEvent } from '@sobremesa/shared-types';
import type { MessageContext } from '@sobremesa/queue';
import { createLogger } from '@sobremesa/shared-utils';
import { ScribeAgent } from './scribe';
import { DEFAULT_SCRIBE_CONFIG } from './types';

const FAMILY_ID = 'family-1';
const EVENT_ID = 'event-1';

function makeEvent(): ConversationEvent {
  const occurredAt = new Date('2026-01-15T18:00:00.000Z');
  return {
    id: EVENT_ID,
    familyId: FAMILY_ID,
    sequenceNumber: 1,
    source: 'telegram',
    conversationId: 'chat-1',
    externalEventId: 'ext-1',
    actorExternalId: 'sender-1',
    actorDisplayName: 'Rosa',
    actorUsername: 'rosa',
    eventType: 'message',
    contentOriginal: 'My mother Rosa was born in Oaxaca in 1943.',
    languageOriginal: 'en',
    metadata: {},
    sourcePayload: {},
    occurredAt,
    ingestedAt: occurredAt,
  };
}

function makeContext(): MessageContext {
  return { recentMessages: [], recentImages: [] };
}

/** Provider fake that records every completion request and returns an empty extraction. */
function makeProvider(): {
  provider: AIProvider;
  requests: AICompletionRequest[];
} {
  const requests: AICompletionRequest[] = [];
  const provider: AIProvider = {
    name: 'fake',
    async complete(
      request: AICompletionRequest,
    ): Promise<AICompletionResponse> {
      requests.push(request);
      return {
        content: '{}',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        model: request.model,
      };
    },
    supportsVision: () => false,
  };
  return { provider, requests };
}

function makeScribe(options?: { temperature?: number }) {
  const { provider, requests } = makeProvider();
  const event = makeEvent();
  const scribe = new ScribeAgent({
    provider,
    model: 'test-model',
    eventRepo: {
      findById: async () => event,
    } as unknown as ConversationEventRepository,
    familyRepo: {
      findById: async () => null,
    } as unknown as FamilyRepository,
    imageRepo: {
      findRecentInConversation: async () => [],
    } as unknown as ImageRepository,
    logger: createLogger({ name: 'scribe-spec', level: 'silent' }),
    config:
      options?.temperature !== undefined
        ? { temperature: options.temperature }
        : undefined,
  });
  return { scribe, requests };
}

describe('ScribeAgent provider request', () => {
  it('pins sampling temperature to the config default rather than the provider default', async () => {
    const { scribe, requests } = makeScribe();

    await scribe.process(EVENT_ID, FAMILY_ID, makeContext());

    expect(requests).toHaveLength(1);
    expect(requests[0].temperature).toBe(DEFAULT_SCRIBE_CONFIG.temperature);
    expect(requests[0].temperature).toBe(0);
  });

  it('threads a temperature override from ScribeConfig into the request', async () => {
    const { scribe, requests } = makeScribe({ temperature: 0.7 });

    await scribe.process(EVENT_ID, FAMILY_ID, makeContext());

    expect(requests).toHaveLength(1);
    expect(requests[0].temperature).toBe(0.7);
  });
});
