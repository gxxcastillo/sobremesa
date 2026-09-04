import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runInternTriage, runExtractionDrain } from './intern-triage';

const buildMessagePipeline = vi.fn();

vi.mock('@sobremesa/pipeline', () => ({
  buildMessagePipeline: (...args: unknown[]) => buildMessagePipeline(...args),
}));

const FAMILY_ID = 'family-1';
const JOB_ID = 'job-1';
const CONVERSATION_ID = 'conv-1';

function createEventsQueryStub(eventIds: string[]) {
  const chain: Record<string, unknown> = {};
  chain['select'] = vi.fn().mockReturnValue(chain);
  chain['eq'] = vi.fn().mockReturnValue(chain);
  chain['is'] = vi.fn().mockReturnValue(chain);
  chain['order'] = vi
    .fn()
    .mockResolvedValue({ data: eventIds.map((id) => ({ id })), error: null });
  return chain;
}

function createDbClientStub(eventIds: string[]) {
  return { from: vi.fn().mockReturnValue(createEventsQueryStub(eventIds)) };
}

function createQueueRepoStub() {
  return {
    enqueue: vi.fn().mockResolvedValue(undefined),
    findByEventId: vi
      .fn()
      .mockImplementation(async (_familyId: string, eventId: string) => ({
        id: `queue-${eventId}`,
        conversationEventId: eventId,
      })),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue('queued'),
  };
}

describe('runInternTriage', () => {
  let queueRepo: ReturnType<typeof createQueueRepoStub>;
  let decisionRepo: {
    upsert: ReturnType<typeof vi.fn>;
    getCounts: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    queueRepo = createQueueRepoStub();
    decisionRepo = {
      upsert: vi.fn().mockResolvedValue(undefined),
      getCounts: vi
        .fn()
        .mockResolvedValue({ toProcess: 1, toSkip: 1, overridden: 0 }),
    };
  });

  it('enqueues every event with intent "triage" and drains them directly (not dequeueAny)', async () => {
    const dbClient = createDbClientStub(['event-a', 'event-b']);
    const processResults: Record<string, { success: boolean; error?: string }> =
      {
        'event-a': { success: true },
        'event-b': { success: false, error: 'boom' },
      };
    const process = vi
      .fn()
      .mockImplementation(async (eventId: string) => processResults[eventId]);
    buildMessagePipeline.mockReturnValue({ process });

    const result = await runInternTriage({
      dbClient: dbClient as never,
      decisionRepo: decisionRepo as never,
      queueRepo: queueRepo as never,
      familyId: FAMILY_ID,
      importJobId: JOB_ID,
      conversationId: CONVERSATION_ID,
      internProvider: {} as never,
      internModel: 'mock-model',
    });

    expect(queueRepo.enqueue).toHaveBeenCalledWith(FAMILY_ID, 'event-a', {
      intent: 'triage',
    });
    expect(queueRepo.enqueue).toHaveBeenCalledWith(FAMILY_ID, 'event-b', {
      intent: 'triage',
    });

    expect(process).toHaveBeenCalledWith('event-a', FAMILY_ID);
    expect(process).toHaveBeenCalledWith('event-b', FAMILY_ID);
    expect(queueRepo.complete).toHaveBeenCalledWith(FAMILY_ID, 'queue-event-a');
    expect(queueRepo.fail).toHaveBeenCalledWith(
      FAMILY_ID,
      'queue-event-b',
      'boom',
    );

    expect(result.total).toBe(2);
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.counts).toEqual({ toProcess: 1, toSkip: 1, overridden: 0 });

    const pipelineOptions = buildMessagePipeline.mock.calls[0][0];
    expect([...pipelineOptions.stages]).toEqual(['router', 'filter']);
    expect(pipelineOptions.providers.intern).toBeDefined();
    expect(pipelineOptions.models.intern).toBe('mock-model');
  });

  it('records every filter verdict into intern_decisions via onFilterDecision, relevant or not', async () => {
    const dbClient = createDbClientStub(['event-a']);
    buildMessagePipeline.mockReturnValue({
      process: vi.fn().mockResolvedValue({ success: true }),
    });

    await runInternTriage({
      dbClient: dbClient as never,
      decisionRepo: decisionRepo as never,
      queueRepo: queueRepo as never,
      familyId: FAMILY_ID,
      importJobId: JOB_ID,
      conversationId: CONVERSATION_ID,
      internProvider: {} as never,
      internModel: 'mock-model',
    });

    const pipelineOptions = buildMessagePipeline.mock.calls[0][0];
    await pipelineOptions.onFilterDecision('event-a', FAMILY_ID, {
      relevant: true,
      reason: 'Family history content',
    });
    await pipelineOptions.onFilterDecision('event-b', FAMILY_ID, {
      relevant: false,
      reason: 'Off-topic banter',
    });

    expect(decisionRepo.upsert).toHaveBeenCalledWith(
      FAMILY_ID,
      JOB_ID,
      'event-a',
      'process',
      'Family history content',
    );
    expect(decisionRepo.upsert).toHaveBeenCalledWith(
      FAMILY_ID,
      JOB_ID,
      'event-b',
      'skip',
      'Off-topic banter',
    );
  });

  it('reports progress after every event', async () => {
    const dbClient = createDbClientStub(['event-a', 'event-b']);
    buildMessagePipeline.mockReturnValue({
      process: vi.fn().mockResolvedValue({ success: true }),
    });
    const onProgress = vi.fn();

    await runInternTriage({
      dbClient: dbClient as never,
      decisionRepo: decisionRepo as never,
      queueRepo: queueRepo as never,
      familyId: FAMILY_ID,
      importJobId: JOB_ID,
      conversationId: CONVERSATION_ID,
      internProvider: {} as never,
      internModel: 'mock-model',
      onProgress,
    });

    expect(onProgress).toHaveBeenNthCalledWith(1, 1, 2);
    expect(onProgress).toHaveBeenNthCalledWith(2, 2, 2);
  });
});

describe('runExtractionDrain', () => {
  let queueRepo: ReturnType<typeof createQueueRepoStub>;

  beforeEach(() => {
    vi.clearAllMocks();
    queueRepo = createQueueRepoStub();
  });

  it('enqueues every given event id with intent "extract" and wires only scribe+registrar (no filter)', async () => {
    const process = vi.fn().mockResolvedValue({ success: true });
    buildMessagePipeline.mockReturnValue({ process });

    const result = await runExtractionDrain({
      dbClient: {} as never,
      queueRepo: queueRepo as never,
      familyId: FAMILY_ID,
      eventIds: ['event-a', 'event-b'],
      scribeProvider: {} as never,
      scribeModel: 'mock-scribe-model',
    });

    expect(queueRepo.enqueue).toHaveBeenCalledWith(FAMILY_ID, 'event-a', {
      intent: 'extract',
    });
    expect(queueRepo.enqueue).toHaveBeenCalledWith(FAMILY_ID, 'event-b', {
      intent: 'extract',
    });
    expect(result.total).toBe(2);
    expect(result.processed).toBe(2);
    expect(result.failed).toBe(0);

    const pipelineOptions = buildMessagePipeline.mock.calls[0][0];
    expect([...pipelineOptions.stages]).toEqual(['scribe', 'registrar']);
    expect(pipelineOptions.onFilterDecision).toBeUndefined();
    expect(pipelineOptions.providers.scribe).toBeDefined();
    expect(pipelineOptions.models.scribe).toBe('mock-scribe-model');
  });

  it("completes/fails each event's own queue row based on the processor result", async () => {
    const process = vi
      .fn()
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'scribe blew up' });
    buildMessagePipeline.mockReturnValue({ process });

    await runExtractionDrain({
      dbClient: {} as never,
      queueRepo: queueRepo as never,
      familyId: FAMILY_ID,
      eventIds: ['event-a', 'event-b'],
      scribeProvider: {} as never,
      scribeModel: 'mock-scribe-model',
    });

    expect(queueRepo.complete).toHaveBeenCalledWith(FAMILY_ID, 'queue-event-a');
    expect(queueRepo.fail).toHaveBeenCalledWith(
      FAMILY_ID,
      'queue-event-b',
      'scribe blew up',
    );
  });
});
