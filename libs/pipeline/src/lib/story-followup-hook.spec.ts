import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GeneratedQuestion, Question } from '@sobremesa/shared-types';
import { createStoryFollowupHook } from './story-followup-hook';

const mockFollowup = {
  formulate: vi.fn(),
};

const mockQuestionRepo = {
  hasWaitingOrRecent: vi.fn(),
  createFromGenerated: vi.fn(),
};

const mockEventLog = {
  log: vi.fn(),
};

const silentLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const FAMILY_ID = 'family-1';
const EVENT_ID = 'event-1';

const generatedQuestion: GeneratedQuestion = {
  content: '¿Cómo eligieron el nombre?',
  language: 'es',
  priority: 50,
  origin: 'followup',
  storyContext: 'the naming story',
};

function createHook() {
  return createStoryFollowupHook({
    followup: mockFollowup as any,
    questionRepo: mockQuestionRepo as any,
    eventLog: mockEventLog as any,
    logger: silentLogger as any,
  });
}

function evaluatedEntry(outcome: string, severity = 'info') {
  return {
    familyId: FAMILY_ID,
    eventType: 'followup_evaluated',
    eventCategory: 'system_event',
    actor: 'followup',
    actorType: 'system',
    conversationEventId: EVENT_ID,
    eventData: { outcome },
    severity,
  };
}

describe('createStoryFollowupHook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuestionRepo.hasWaitingOrRecent.mockResolvedValue(false);
  });

  it('skips formulation entirely when the pacing pre-check finds a waiting or recent question', async () => {
    mockQuestionRepo.hasWaitingOrRecent.mockResolvedValue(true);
    const hook = createHook();

    await hook(EVENT_ID, FAMILY_ID, 'es');

    expect(mockQuestionRepo.hasWaitingOrRecent).toHaveBeenCalledWith(
      FAMILY_ID,
      24,
    );
    expect(mockFollowup.formulate).not.toHaveBeenCalled();
    expect(mockQuestionRepo.createFromGenerated).not.toHaveBeenCalled();
    expect(mockEventLog.log).toHaveBeenCalledExactlyOnceWith(
      evaluatedEntry('suppressed_pacing'),
    );
  });

  it('formulates with the source event id and routed language, and persists nothing on a decline', async () => {
    mockFollowup.formulate.mockResolvedValue({
      ask: false,
      outcome: 'declined',
      reason: 'no story worth a follow-up',
      namesUsed: [],
    });
    const hook = createHook();

    await hook(EVENT_ID, FAMILY_ID, 'es');

    expect(mockFollowup.formulate).toHaveBeenCalledWith({
      familyId: FAMILY_ID,
      domainModel: { conversationEventId: EVENT_ID, detectedLanguage: 'es' },
    });
    expect(mockQuestionRepo.createFromGenerated).not.toHaveBeenCalled();
    // The outcome category only -- never the model's free-text reason.
    expect(mockEventLog.log).toHaveBeenCalledExactlyOnceWith(
      evaluatedEntry('declined'),
    );
  });

  it.each(['provider_error', 'unparseable_response'])(
    'records a %s as an error-severity outcome, distinct from a decline',
    async (outcome) => {
      mockFollowup.formulate.mockResolvedValue({
        ask: false,
        outcome,
        reason: 'formulation call failed',
        namesUsed: [],
      });
      const hook = createHook();

      await hook(EVENT_ID, FAMILY_ID, 'es');

      expect(mockQuestionRepo.createFromGenerated).not.toHaveBeenCalled();
      expect(mockEventLog.log).toHaveBeenCalledExactlyOnceWith(
        evaluatedEntry(outcome, 'error'),
      );
    },
  );

  it('persists the generated question with a 24h expiry and logs question_proposed on ask', async () => {
    mockFollowup.formulate.mockResolvedValue({
      ask: true,
      outcome: 'asked',
      question: generatedQuestion,
      reason: 'names the naming story',
      namesUsed: ['Luciana'],
    });
    const created: Question = {
      id: 'question-1',
      familyId: FAMILY_ID,
      contentOriginal: generatedQuestion.content,
      languageOriginal: generatedQuestion.language,
      origin: 'followup',
      status: 'proposed',
      priority: 50,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Question;
    mockQuestionRepo.createFromGenerated.mockResolvedValue(created);
    const before = Date.now();
    const hook = createHook();

    await hook(EVENT_ID, FAMILY_ID, undefined);

    expect(mockQuestionRepo.createFromGenerated).toHaveBeenCalledTimes(1);
    const [familyIdArg, questionArg, sourceMessageIdArg, expiresAtArg] =
      mockQuestionRepo.createFromGenerated.mock.calls[0];
    expect(familyIdArg).toBe(FAMILY_ID);
    expect(questionArg).toBe(generatedQuestion);
    expect(sourceMessageIdArg).toBe(EVENT_ID);
    expect(expiresAtArg).toBeInstanceOf(Date);
    const expiresInMs = expiresAtArg.getTime() - before;
    expect(expiresInMs).toBeGreaterThan(23.9 * 60 * 60 * 1000);
    expect(expiresInMs).toBeLessThan(24.1 * 60 * 60 * 1000);

    expect(mockEventLog.log).toHaveBeenCalledWith({
      familyId: FAMILY_ID,
      eventType: 'question_proposed',
      eventCategory: 'system_event',
      actor: 'followup',
      actorType: 'system',
      conversationEventId: EVENT_ID,
      eventData: { questionId: 'question-1', namesUsed: ['Luciana'] },
    });
  });

  it('treats an ask result missing its question as a decline (defensive, matches FollowupResult typing)', async () => {
    mockFollowup.formulate.mockResolvedValue({
      ask: true,
      outcome: 'asked',
      question: undefined,
      reason: 'inconsistent result',
      namesUsed: [],
    });
    const hook = createHook();

    await hook(EVENT_ID, FAMILY_ID, 'en');

    expect(mockQuestionRepo.createFromGenerated).not.toHaveBeenCalled();
    expect(mockEventLog.log).toHaveBeenCalledExactlyOnceWith(
      evaluatedEntry('declined'),
    );
  });
});
