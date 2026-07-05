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

  it('passes answered bot-question context to Scribe', async () => {
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
      askedByName: 'Facilitator',
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
