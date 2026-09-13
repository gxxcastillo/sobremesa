import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runImportDrain } from './import-drain';

const buildMessagePipeline = vi.fn();

vi.mock('@sobremesa/pipeline', () => ({
  buildMessagePipeline: (...args: unknown[]) => buildMessagePipeline(...args),
}));

const FAMILY_ID = 'family-1';
const CONVERSATION_ID = 'conv-1';
const JOB_ID = 'job-1';

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

/** Stub for `ImportJobRepository.findById`'s `.select('*').eq('id', id).single()`. */
function createImportJobQueryStub(getStatus: () => string) {
  const chain: Record<string, unknown> = {};
  chain['select'] = vi.fn().mockReturnValue(chain);
  chain['eq'] = vi.fn().mockReturnValue(chain);
  chain['single'] = vi.fn().mockImplementation(async () => ({
    data: {
      id: JOB_ID,
      created_by: 'user-1',
      status: getStatus(),
      source: 'whatsapp',
      config: {},
      progress: { current: 0, total: 0, stage: '' },
      batch_ids: [],
      family_id: FAMILY_ID,
      conversation_id: CONVERSATION_ID,
      started_at: new Date().toISOString(),
    },
    error: null,
  }));
  return chain;
}

/**
 * `jobStatus` is read lazily (via a getter) so a test can flip it mid-drain
 * to simulate a concurrent cancel.
 */
function createDbClientStub(
  eventIds: string[],
  jobStatus: () => string = () => 'processing',
) {
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'import_jobs') {
        return createImportJobQueryStub(jobStatus);
      }
      return createEventsQueryStub(eventIds);
    }),
  };
}

function createQueueRepoStub(statusByEventId: Record<string, string> = {}) {
  return {
    enqueue: vi
      .fn()
      .mockImplementation(async (_familyId: string, eventId: string) => ({
        id: `queue-${eventId}`,
        conversationEventId: eventId,
        status: statusByEventId[eventId] ?? 'queued',
      })),
    findByEventId: vi
      .fn()
      .mockImplementation(async (_familyId: string, eventId: string) => ({
        id: `queue-${eventId}`,
        conversationEventId: eventId,
        status: statusByEventId[eventId] ?? 'queued',
      })),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue('queued'),
  };
}

describe('runImportDrain', () => {
  let queueRepo: ReturnType<typeof createQueueRepoStub>;

  beforeEach(() => {
    vi.clearAllMocks();
    queueRepo = createQueueRepoStub();
  });

  it('enqueues every event with intent "import" and drains them directly (not dequeueAny)', async () => {
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

    const result = await runImportDrain({
      dbClient: dbClient as never,
      queueRepo: queueRepo as never,
      jobId: JOB_ID,
      familyId: FAMILY_ID,
      conversationId: CONVERSATION_ID,
      internProvider: {} as never,
      internModel: 'mock-intern-model',
      scribeProvider: {} as never,
      scribeModel: 'mock-scribe-model',
    });

    expect(queueRepo.enqueue).toHaveBeenCalledWith(FAMILY_ID, 'event-a', {
      intent: 'import',
    });
    expect(queueRepo.enqueue).toHaveBeenCalledWith(FAMILY_ID, 'event-b', {
      intent: 'import',
    });

    expect(process).toHaveBeenCalledWith('event-a', FAMILY_ID);
    expect(process).toHaveBeenCalledWith('event-b', FAMILY_ID);
    expect(queueRepo.complete).toHaveBeenCalledWith(FAMILY_ID, 'queue-event-a');
    expect(queueRepo.fail).toHaveBeenCalledWith(
      FAMILY_ID,
      'queue-event-b',
      'boom',
      3,
    );

    expect(result.total).toBe(2);
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('wires the full router/filter/imageLinker/scribe/registrar stage set -- never admin/historian/facilitatorNudge', async () => {
    const dbClient = createDbClientStub(['event-a']);
    buildMessagePipeline.mockReturnValue({
      process: vi.fn().mockResolvedValue({ success: true }),
    });

    await runImportDrain({
      dbClient: dbClient as never,
      queueRepo: queueRepo as never,
      jobId: JOB_ID,
      familyId: FAMILY_ID,
      conversationId: CONVERSATION_ID,
      internProvider: {} as never,
      internModel: 'mock-intern-model',
      scribeProvider: {} as never,
      scribeModel: 'mock-scribe-model',
    });

    const pipelineOptions = buildMessagePipeline.mock.calls[0][0];
    expect([...pipelineOptions.stages].sort()).toEqual(
      ['imageLinker', 'registrar', 'router', 'scribe', 'filter'].sort(),
    );
    expect(pipelineOptions.providers.intern).toBeDefined();
    expect(pipelineOptions.providers.scribe).toBeDefined();
    expect(pipelineOptions.models.intern).toBe('mock-intern-model');
    expect(pipelineOptions.models.scribe).toBe('mock-scribe-model');
    // No messageSender is passed, so buildMessagePipeline would itself throw
    // if any of these stages were requested -- confirmed structurally here
    // since the mock never validates, but the stage-set assertion above is
    // what guarantees they're never requested at all.
    expect(pipelineOptions.messageSender).toBeUndefined();
  });

  it('reports final progress even when the drain is smaller than the report interval', async () => {
    const dbClient = createDbClientStub(['event-a', 'event-b']);
    buildMessagePipeline.mockReturnValue({
      process: vi.fn().mockResolvedValue({ success: true }),
    });
    const onProgress = vi.fn();

    await runImportDrain({
      dbClient: dbClient as never,
      queueRepo: queueRepo as never,
      jobId: JOB_ID,
      familyId: FAMILY_ID,
      conversationId: CONVERSATION_ID,
      internProvider: {} as never,
      internModel: 'mock-intern-model',
      scribeProvider: {} as never,
      scribeModel: 'mock-scribe-model',
      onProgress,
    });

    // Progress is throttled (a DB write per call), so a 2-event drain only
    // reports once, at completion -- not after every single event.
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith(2, 2);
  });

  it('throttles progress reporting to every 10th event plus the final one', async () => {
    const eventIds = Array.from({ length: 25 }, (_, i) => `event-${i}`);
    const dbClient = createDbClientStub(eventIds);
    buildMessagePipeline.mockReturnValue({
      process: vi.fn().mockResolvedValue({ success: true }),
    });
    const onProgress = vi.fn();

    await runImportDrain({
      dbClient: dbClient as never,
      queueRepo: queueRepo as never,
      jobId: JOB_ID,
      familyId: FAMILY_ID,
      conversationId: CONVERSATION_ID,
      internProvider: {} as never,
      internModel: 'mock-intern-model',
      scribeProvider: {} as never,
      scribeModel: 'mock-scribe-model',
      onProgress,
    });

    expect(onProgress.mock.calls.map((call) => call[0])).toEqual([10, 20, 25]);
  });

  it('stops processing further events once the job is cancelled mid-drain', async () => {
    const eventIds = Array.from({ length: 25 }, (_, i) => `event-${i}`);
    // Flips to 'cancelled' only once the throttled check (every 10 events)
    // would observe it -- simulates a cancel landing after event 10.
    let status = 'processing';
    const dbClient = createDbClientStub(eventIds, () => status);
    const process = vi.fn().mockImplementation(async (eventId: string) => {
      if (eventId === 'event-9') {
        // The 10th processed event (0-indexed) -- flip status right after
        // it's processed, before the throttled cancellation check runs.
        status = 'cancelled';
      }
      return { success: true };
    });
    buildMessagePipeline.mockReturnValue({ process });

    const result = await runImportDrain({
      dbClient: dbClient as never,
      queueRepo: queueRepo as never,
      jobId: JOB_ID,
      familyId: FAMILY_ID,
      conversationId: CONVERSATION_ID,
      internProvider: {} as never,
      internModel: 'mock-intern-model',
      scribeProvider: {} as never,
      scribeModel: 'mock-scribe-model',
    });

    // Only the first 10 events were processed before the drain observed the
    // cancellation and stopped -- the remaining 15 are never touched, so no
    // further Scribe/Registrar writes happen for a cancelled import.
    expect(process).toHaveBeenCalledTimes(10);
    expect(result).toEqual({ total: 25, processed: 10, failed: 0 });
  });

  it('skips reprocessing an event whose queue row is already done (resumed job)', async () => {
    const dbClient = createDbClientStub(['event-a', 'event-b']);
    queueRepo = createQueueRepoStub({ 'event-a': 'done' });
    const process = vi.fn().mockResolvedValue({ success: true });
    buildMessagePipeline.mockReturnValue({ process });

    const result = await runImportDrain({
      dbClient: dbClient as never,
      queueRepo: queueRepo as never,
      jobId: JOB_ID,
      familyId: FAMILY_ID,
      conversationId: CONVERSATION_ID,
      internProvider: {} as never,
      internModel: 'mock-intern-model',
      scribeProvider: {} as never,
      scribeModel: 'mock-scribe-model',
    });

    // event-a was already 'done' from an earlier pass -- never reprocessed
    // (Scribe/Registrar would otherwise duplicate its extracted claims).
    expect(process).not.toHaveBeenCalledWith('event-a', FAMILY_ID);
    expect(process).toHaveBeenCalledWith('event-b', FAMILY_ID);
    expect(result).toEqual({ total: 2, processed: 2, failed: 0 });
  });

  it('continues past a per-event failure instead of aborting the drain', async () => {
    const dbClient = createDbClientStub(['event-a', 'event-b', 'event-c']);
    const processResults: Record<string, { success: boolean; error?: string }> =
      {
        'event-a': { success: true },
        'event-b': { success: false, error: 'scribe blew up' },
        'event-c': { success: true },
      };
    buildMessagePipeline.mockReturnValue({
      process: vi
        .fn()
        .mockImplementation(async (eventId: string) => processResults[eventId]),
    });

    const result = await runImportDrain({
      dbClient: dbClient as never,
      queueRepo: queueRepo as never,
      jobId: JOB_ID,
      familyId: FAMILY_ID,
      conversationId: CONVERSATION_ID,
      internProvider: {} as never,
      internModel: 'mock-intern-model',
      scribeProvider: {} as never,
      scribeModel: 'mock-scribe-model',
    });

    expect(result).toEqual({ total: 3, processed: 2, failed: 1 });
  });
});
