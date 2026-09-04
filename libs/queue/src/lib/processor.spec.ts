import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageProcessor } from './processor';
import type { ScribeDomainModel } from '@sobremesa/shared-types';

const mockEventRepo = {
  findById: vi.fn(),
  findRecent: vi.fn(),
  findByExternalId: vi.fn(),
};

const mockProcessingRepo = {
  upsert: vi.fn(),
  updateMetadata: vi.fn(),
};

const mockEventLog = {
  log: vi.fn(),
};

const mockQuestionRepo = {
  findByExternalMessageId: vi.fn(),
  markAnswered: vi.fn(),
};

const mockImageRepo = {
  findRecentInConversation: vi.fn(),
  findByExternalFileId: vi.fn(),
  createFromEvent: vi.fn(),
};

const mockQueueRepo = {
  findByEventId: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
};

const silentLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const FAMILY_ID = 'family-1';
const EVENT_ID = 'event-1';

const baseEvent = {
  id: EVENT_ID,
  familyId: FAMILY_ID,
  conversationId: 'conv-1',
  sequenceNumber: 5,
  source: 'telegram',
  externalEventId: 'ext-1',
  actorExternalId: 'actor-1',
  actorDisplayName: 'Alice',
  eventType: 'message' as const,
  contentOriginal: 'Hello world',
  occurredAt: new Date('2026-01-01T00:00:00Z'),
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const baseQueueItem = {
  id: 'queue-1',
  familyId: FAMILY_ID,
  conversationEventId: EVENT_ID,
  status: 'processing' as const,
  attempts: 0,
  priority: 5,
  queuedAt: new Date('2026-01-01T00:00:00Z'),
  processAfter: new Date('2026-01-01T00:00:00Z'),
};

function createBaseDomainModel(): ScribeDomainModel {
  return {
    conversationEventId: EVENT_ID,
    familyId: FAMILY_ID,
    processedAt: new Date(),
    people: [],
    places: [],
    events: [],
    relationships: [],
    claims: [],
    imageReferences: [],
  };
}

function createProcessor(): MessageProcessor {
  return new MessageProcessor({
    eventRepo: mockEventRepo as any,
    processingRepo: mockProcessingRepo as any,
    eventLog: mockEventLog as any,
    questionRepo: mockQuestionRepo as any,
    imageRepo: mockImageRepo as any,
    queueRepo: mockQueueRepo as any,
    logger: silentLogger as any,
  });
}

describe('MessageProcessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEventRepo.findById.mockResolvedValue({ ...baseEvent });
    mockEventRepo.findRecent.mockResolvedValue([]);
    mockEventRepo.findByExternalId.mockResolvedValue(null);
    mockImageRepo.findRecentInConversation.mockResolvedValue([]);
    mockQueueRepo.findByEventId.mockResolvedValue({ ...baseQueueItem });
    mockEventLog.log.mockResolvedValue(undefined);
  });

  it('returns recent message context oldest first after selecting the newest window', async () => {
    mockEventRepo.findRecent.mockResolvedValue([
      {
        id: 'event-new',
        contentOriginal: 'Newest',
        actorDisplayName: 'Nina',
        occurredAt: new Date('2026-01-03T12:00:00Z'),
      },
      {
        id: 'event-mid',
        contentOriginal: 'Middle',
        actorDisplayName: 'Marta',
        occurredAt: new Date('2026-01-02T12:00:00Z'),
      },
      {
        id: 'event-old',
        contentOriginal: 'Oldest',
        actorDisplayName: 'Olivia',
        occurredAt: new Date('2026-01-01T12:00:00Z'),
      },
    ]);
    const processor = createProcessor();

    const context = await processor.fetchContext(FAMILY_ID, 'conv-1');

    expect(context.recentMessages.map((msg) => msg.id)).toEqual([
      'event-old',
      'event-mid',
      'event-new',
    ]);
  });

  it('adds a visible replied-to message to shared context', async () => {
    mockEventRepo.findByExternalId.mockResolvedValue({
      id: 'reply-event',
      contentOriginal: 'The wedding was in 1982.',
      actorDisplayName: 'Carlos',
      occurredAt: new Date('2026-01-01T12:00:00Z'),
    });
    const processor = createProcessor();

    const context = await processor.fetchContext(FAMILY_ID, 'conv-1', {
      replyTo: {
        source: 'telegram',
        externalEventId: '42',
      },
    });

    expect(mockEventRepo.findByExternalId).toHaveBeenCalledWith(
      FAMILY_ID,
      'telegram',
      'conv-1',
      '42',
      true,
    );
    expect(context.replyToMessage).toEqual({
      id: 'reply-event',
      content: 'The wedding was in 1982.',
      senderName: 'Carlos',
      occurredAt: new Date('2026-01-01T12:00:00Z'),
    });
  });

  it('returns failure and never completes the queue item when the event is missing', async () => {
    mockEventRepo.findById.mockResolvedValue(null);
    const processor = createProcessor();

    const result = await processor.process(EVENT_ID, FAMILY_ID);

    expect(result.success).toBe(false);
    expect(result.error).toContain(EVENT_ID);
    expect(mockQueueRepo.complete).not.toHaveBeenCalled();
  });

  it('returns failure and never completes the queue item when no queue item exists', async () => {
    mockQueueRepo.findByEventId.mockResolvedValue(null);
    const processor = createProcessor();

    const result = await processor.process(EVENT_ID, FAMILY_ID);

    expect(result.success).toBe(false);
    expect(mockQueueRepo.complete).not.toHaveBeenCalled();
  });

  it('reports success without completing the queue item when routed to ignore', async () => {
    const processor = createProcessor();
    processor.setRouter(async () => ({ action: 'ignore', reason: 'spam' }));
    const scribe = vi.fn();
    processor.setScribe(scribe);

    const result = await processor.process(EVENT_ID, FAMILY_ID);

    expect(result.success).toBe(true);
    expect(scribe).not.toHaveBeenCalled();
    expect(mockQueueRepo.complete).not.toHaveBeenCalled();
  });

  it('routes to the admin processor and reports success without completing the queue item', async () => {
    const processor = createProcessor();
    processor.setRouter(async () => ({
      action: 'admin',
      adminSubtype: 'command',
      reason: 'admin command',
    }));
    const adminProcessor = vi.fn().mockResolvedValue({ success: true });
    processor.setAdminProcessor(adminProcessor);
    const scribe = vi.fn();
    processor.setScribe(scribe);

    const result = await processor.process(EVENT_ID, FAMILY_ID);

    expect(result.success).toBe(true);
    expect(adminProcessor).toHaveBeenCalledWith(EVENT_ID, FAMILY_ID, 'command');
    expect(scribe).not.toHaveBeenCalled();
    expect(mockQueueRepo.complete).not.toHaveBeenCalled();
  });

  it('reports failure when the admin processor fails, so the queue retries instead of completing', async () => {
    const processor = createProcessor();
    processor.setRouter(async () => ({
      action: 'admin',
      adminSubtype: 'command',
      reason: 'admin command',
    }));
    const adminProcessor = vi
      .fn()
      .mockResolvedValue({ success: false, error: 'db unavailable' });
    processor.setAdminProcessor(adminProcessor);
    const scribe = vi.fn();
    processor.setScribe(scribe);

    const result = await processor.process(EVENT_ID, FAMILY_ID);

    expect(result.success).toBe(false);
    expect(result.error).toBe('db unavailable');
    expect(mockQueueRepo.complete).not.toHaveBeenCalled();
  });

  it('falls through to the scribe pipeline after routing to historian', async () => {
    const callOrder: string[] = [];
    const processor = createProcessor();
    processor.setRouter(async () => ({
      action: 'historian',
      reason: 'question asked',
    }));
    const historianProcessor = vi.fn().mockImplementation(async () => {
      callOrder.push('historian');
      return { success: true };
    });
    processor.setHistorianProcessor(historianProcessor);
    const domainModel = createBaseDomainModel();
    const scribe = vi.fn().mockImplementation(async () => {
      callOrder.push('scribe');
      return domainModel;
    });
    processor.setScribe(scribe);
    const registrar = vi.fn().mockResolvedValue(undefined);
    processor.setRegistrar(registrar);

    const result = await processor.process(EVENT_ID, FAMILY_ID);

    expect(result.success).toBe(true);
    expect(historianProcessor).toHaveBeenCalledWith(EVENT_ID, FAMILY_ID);
    expect(scribe).toHaveBeenCalled();
    expect(callOrder).toEqual(['historian', 'scribe']);
    expect(registrar).toHaveBeenCalledWith(
      domainModel,
      FAMILY_ID,
      undefined,
      expect.any(Array),
    );
    expect(mockQueueRepo.complete).not.toHaveBeenCalled();
  });

  it('reports failure without running scribe when the historian processor fails, so the queue retries instead of completing', async () => {
    const processor = createProcessor();
    processor.setRouter(async () => ({
      action: 'historian',
      reason: 'question asked',
    }));
    const historianProcessor = vi
      .fn()
      .mockResolvedValue({ success: false, error: 'facilitator send failed' });
    processor.setHistorianProcessor(historianProcessor);
    const scribe = vi.fn();
    processor.setScribe(scribe);

    const result = await processor.process(EVENT_ID, FAMILY_ID);

    expect(result.success).toBe(false);
    expect(result.error).toBe('facilitator send failed');
    expect(scribe).not.toHaveBeenCalled();
    expect(mockQueueRepo.complete).not.toHaveBeenCalled();
  });

  it('runs the scribe/registrar happy path and reports success without completing the queue item', async () => {
    const processor = createProcessor();
    const domainModel = createBaseDomainModel();
    const scribe = vi.fn().mockResolvedValue(domainModel);
    processor.setScribe(scribe);
    const registrar = vi.fn().mockResolvedValue(undefined);
    processor.setRegistrar(registrar);

    const result = await processor.process(EVENT_ID, FAMILY_ID);

    expect(result.success).toBe(true);
    expect(scribe).toHaveBeenCalled();
    expect(registrar).toHaveBeenCalledWith(
      domainModel,
      FAMILY_ID,
      undefined,
      expect.any(Array),
    );
    expect(mockQueueRepo.complete).not.toHaveBeenCalled();
  });

  it('runs the filter only once when both a router and a filter are registered', async () => {
    const processor = createProcessor();
    processor.setRouter(async () => ({
      action: 'scribe',
      reason: 'relevant',
      language: 'es',
    }));
    // Intern's route() already calls filter() internally, and a router-
    // decided 'ignore' already short-circuits before processTextContent
    // runs -- so this separately registered filter must not be invoked
    // again for a 'scribe' routing outcome.
    const filter = vi.fn().mockResolvedValue({ relevant: true, reason: 'ok' });
    processor.setFilter(filter);
    const domainModel = createBaseDomainModel();
    const scribe = vi.fn().mockResolvedValue(domainModel);
    processor.setScribe(scribe);
    processor.setRegistrar(vi.fn().mockResolvedValue(undefined));

    const result = await processor.process(EVENT_ID, FAMILY_ID);

    expect(result.success).toBe(true);
    expect(filter).not.toHaveBeenCalled();
    expect(scribe).toHaveBeenCalled();
  });

  it('still persists detected-language drift when the router (not a second filter call) is the only source of it', async () => {
    const processor = createProcessor();
    processor.setRouter(async () => ({
      action: 'scribe',
      reason: 'relevant',
      language: 'es',
    }));
    processor.setFilter(vi.fn());
    processor.setScribe(vi.fn().mockResolvedValue(createBaseDomainModel()));
    processor.setRegistrar(vi.fn().mockResolvedValue(undefined));

    const result = await processor.process(EVENT_ID, FAMILY_ID);

    expect(result.success).toBe(true);
    expect(mockProcessingRepo.upsert).toHaveBeenCalledWith({
      conversationEventId: EVENT_ID,
      familyId: FAMILY_ID,
      detectedLanguage: 'es',
      processedBy: 'intern',
    });
  });

  it('passes context message contents (recent + replied-to, not bot question) to the registrar for grounding', async () => {
    mockEventRepo.findById.mockResolvedValue({
      ...baseEvent,
      externalReplyToId: '42',
    });
    mockEventRepo.findRecent.mockResolvedValue([
      {
        id: 'event-prev',
        contentOriginal: 'Rosa moved to Guadalajara.',
        actorDisplayName: 'Marta',
        occurredAt: new Date('2026-01-02T12:00:00Z'),
      },
    ]);
    mockEventRepo.findByExternalId.mockResolvedValue({
      id: 'reply-event',
      contentOriginal: 'The wedding was in 1982.',
      actorDisplayName: 'Carlos',
      occurredAt: new Date('2026-01-01T12:00:00Z'),
    });
    const processor = createProcessor();
    const domainModel = createBaseDomainModel();
    processor.setScribe(vi.fn().mockResolvedValue(domainModel));
    const registrar = vi.fn().mockResolvedValue(undefined);
    processor.setRegistrar(registrar);

    const result = await processor.process(EVENT_ID, FAMILY_ID);

    expect(result.success).toBe(true);
    expect(registrar).toHaveBeenCalledWith(domainModel, FAMILY_ID, undefined, [
      'Rosa moved to Guadalajara.',
      'The wedding was in 1982.',
    ]);
  });

  it('falls back to the default persona name when the persisted question has none (legacy row)', async () => {
    mockEventRepo.findById.mockResolvedValue({
      ...baseEvent,
      externalReplyToId: 'bot-question-42',
      contentOriginal: '1943',
    });
    mockQuestionRepo.findByExternalMessageId.mockResolvedValue({
      id: 'question-1',
      status: 'asked',
      contentOriginal: 'What year did your grandmother arrive?',
    });
    const processor = createProcessor();
    const domainModel = createBaseDomainModel();
    const scribe = vi.fn().mockResolvedValue(domainModel);
    processor.setScribe(scribe);
    processor.setRegistrar(vi.fn().mockResolvedValue(undefined));

    const result = await processor.process(EVENT_ID, FAMILY_ID);

    expect(result.success).toBe(true);
    expect(mockQuestionRepo.markAnswered).toHaveBeenCalledWith(
      FAMILY_ID,
      'question-1',
      EVENT_ID,
    );
    expect(scribe).toHaveBeenCalled();
    expect(scribe.mock.calls[0][2].answeredQuestion).toEqual({
      id: 'question-1',
      content: 'What year did your grandmother arrive?',
      askedByName: 'Carmencita',
    });
  });

  it('passes the persisted persona name through to Scribe unchanged', async () => {
    mockEventRepo.findById.mockResolvedValue({
      ...baseEvent,
      externalReplyToId: 'bot-question-42',
      contentOriginal: '1943',
    });
    mockQuestionRepo.findByExternalMessageId.mockResolvedValue({
      id: 'question-1',
      status: 'asked',
      contentOriginal: 'What year did your grandmother arrive?',
      askedByName: 'Abuelita',
    });
    const processor = createProcessor();
    const domainModel = createBaseDomainModel();
    const scribe = vi.fn().mockResolvedValue(domainModel);
    processor.setScribe(scribe);
    processor.setRegistrar(vi.fn().mockResolvedValue(undefined));

    await processor.process(EVENT_ID, FAMILY_ID);

    expect(scribe.mock.calls[0][2].answeredQuestion).toEqual({
      id: 'question-1',
      content: 'What year did your grandmother arrive?',
      askedByName: 'Abuelita',
    });
  });

  it('returns success:false without completing the queue item when scribe throws', async () => {
    const processor = createProcessor();
    processor.setScribe(async () => {
      throw new Error('scribe blew up');
    });
    const registrar = vi.fn();
    processor.setRegistrar(registrar);

    const result = await processor.process(EVENT_ID, FAMILY_ID);

    expect(result.success).toBe(false);
    expect(result.error).toBe('scribe blew up');
    expect(registrar).not.toHaveBeenCalled();
    expect(mockQueueRepo.complete).not.toHaveBeenCalled();
  });

  it('invokes onFilterDecision when the router itself decides to ignore, even though processTextContent never runs', async () => {
    const processor = createProcessor();
    processor.setRouter(async () => ({
      action: 'ignore',
      reason: 'Off-topic banter',
      language: 'es',
      tokensUsed: 42,
    }));
    const filter = vi.fn();
    processor.setFilter(filter);
    const onFilterDecision = vi.fn().mockResolvedValue(undefined);
    processor.setOnFilterDecision(onFilterDecision);
    const scribe = vi.fn();
    processor.setScribe(scribe);

    const result = await processor.process(EVENT_ID, FAMILY_ID);

    expect(result.success).toBe(true);
    expect(onFilterDecision).toHaveBeenCalledWith(EVENT_ID, FAMILY_ID, {
      relevant: false,
      reason: 'Off-topic banter',
      language: 'es',
      tokensUsed: 42,
    });
    // The separate registered filter is never reached -- process() returns
    // for 'ignore' before processTextContent runs.
    expect(filter).not.toHaveBeenCalled();
    expect(scribe).not.toHaveBeenCalled();
  });

  it('invokes onFilterDecision as relevant when both router and filter are set and the router routes to scribe', async () => {
    // Regression test: with both stages wired (the real import-triage
    // configuration -- see libs/import/src/lib/intern-triage.ts), the
    // registered `filter` stage's own onFilterDecision call is skipped
    // (`!this.router` guard in processTextContent) since the router already
    // called filter() internally. Without a synthesized call for the
    // 'scribe' outcome, onFilterDecision would only ever fire for 'ignore'
    // verdicts and never for relevant ones.
    const processor = createProcessor();
    processor.setRouter(async () => ({
      action: 'scribe',
      reason: 'Family story',
      language: 'en',
      tokensUsed: 17,
    }));
    const filter = vi.fn();
    processor.setFilter(filter);
    const onFilterDecision = vi.fn().mockResolvedValue(undefined);
    processor.setOnFilterDecision(onFilterDecision);
    const scribe = vi.fn().mockResolvedValue(createBaseDomainModel());
    processor.setScribe(scribe);
    const registrar = vi.fn();
    processor.setRegistrar(registrar);

    const result = await processor.process(EVENT_ID, FAMILY_ID);

    expect(result.success).toBe(true);
    expect(onFilterDecision).toHaveBeenCalledWith(EVENT_ID, FAMILY_ID, {
      relevant: true,
      reason: 'Family story',
      language: 'en',
      tokensUsed: 17,
    });
    // The separate registered filter is never reached -- the router already
    // decided relevance internally.
    expect(filter).not.toHaveBeenCalled();
    expect(scribe).toHaveBeenCalled();
  });

  it('does not invoke onFilterDecision when the router routes to admin', async () => {
    const processor = createProcessor();
    processor.setRouter(async () => ({
      action: 'admin',
      adminSubtype: 'status' as const,
      reason: 'Command: /status',
    }));
    const onFilterDecision = vi.fn().mockResolvedValue(undefined);
    processor.setOnFilterDecision(onFilterDecision);

    const result = await processor.process(EVENT_ID, FAMILY_ID);

    expect(result.success).toBe(true);
    expect(onFilterDecision).not.toHaveBeenCalled();
  });

  it('invokes onFilterDecision for every filter verdict, relevant or not', async () => {
    const processor = createProcessor();
    const filterResults: Record<string, { relevant: boolean; reason: string }> =
      {
        'event-relevant': { relevant: true, reason: 'Family story' },
        'event-not-relevant': { relevant: false, reason: 'Off-topic' },
      };
    mockEventRepo.findById.mockImplementation(
      async (_familyId: string, eventId: string) => ({
        ...baseEvent,
        id: eventId,
      }),
    );
    mockQueueRepo.findByEventId.mockImplementation(
      async (_familyId: string, eventId: string) => ({
        ...baseQueueItem,
        conversationEventId: eventId,
      }),
    );
    processor.setFilter(async (eventId: string) => filterResults[eventId]);
    const scribe = vi.fn().mockResolvedValue(createBaseDomainModel());
    processor.setScribe(scribe);
    const onFilterDecision = vi.fn().mockResolvedValue(undefined);
    processor.setOnFilterDecision(onFilterDecision);

    await processor.process('event-relevant', FAMILY_ID);
    await processor.process('event-not-relevant', FAMILY_ID);

    expect(onFilterDecision).toHaveBeenCalledWith(
      'event-relevant',
      FAMILY_ID,
      filterResults['event-relevant'],
    );
    expect(onFilterDecision).toHaveBeenCalledWith(
      'event-not-relevant',
      FAMILY_ID,
      filterResults['event-not-relevant'],
    );
    // Only the relevant verdict lets scribe run -- confirms the callback
    // firing doesn't itself change the shouldProcess decision.
    expect(scribe).toHaveBeenCalledTimes(1);
  });

  it('propagates an onFilterDecision error as processing failure (unlike onImageCreated, not swallowed)', async () => {
    const processor = createProcessor();
    processor.setFilter(async () => ({ relevant: true, reason: 'ok' }));
    processor.setOnFilterDecision(async () => {
      throw new Error('db write failed');
    });
    const scribe = vi.fn();
    processor.setScribe(scribe);

    const result = await processor.process(EVENT_ID, FAMILY_ID);

    expect(result.success).toBe(false);
    expect(result.error).toBe('db write failed');
    expect(scribe).not.toHaveBeenCalled();
  });

  it('creates an image record and invokes onImageCreated for media events', async () => {
    mockEventRepo.findById.mockResolvedValue({
      ...baseEvent,
      eventType: 'photo',
      contentOriginal: undefined,
      metadata: { fileId: 'file-1', fileUniqueId: 'unique-1' },
    });
    mockImageRepo.findByExternalFileId.mockResolvedValue(null);
    mockImageRepo.createFromEvent.mockResolvedValue({ id: 'image-1' });
    const processor = createProcessor();
    const onImageCreated = vi.fn();
    processor.setOnImageCreated(onImageCreated);

    const result = await processor.process(EVENT_ID, FAMILY_ID);

    expect(result.success).toBe(true);
    expect(mockImageRepo.createFromEvent).toHaveBeenCalled();
    expect(onImageCreated).toHaveBeenCalledWith(FAMILY_ID, 'image-1', EVENT_ID);
    expect(mockQueueRepo.complete).not.toHaveBeenCalled();
  });

  it('createHandler delegates to process', async () => {
    const processor = createProcessor();
    const domainModel = createBaseDomainModel();
    processor.setScribe(vi.fn().mockResolvedValue(domainModel));
    processor.setRegistrar(vi.fn().mockResolvedValue(undefined));

    const handler = processor.createHandler();
    const result = await handler(EVENT_ID, FAMILY_ID);

    expect(result.success).toBe(true);
  });
});
