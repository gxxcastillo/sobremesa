import { FollowupAgent, type FollowupResult } from '@sobremesa/agents-followup';
import {
  FacilitatorAgent,
  type AskQuestionResult,
  type MessageSender,
} from '@sobremesa/agents-facilitator';
import type { AICompletionResponse, AIProvider } from '@sobremesa/ai-provider';
import type {
  ConversationEvent,
  EventCategory,
  EventLogType,
  Family,
  Question,
  SendOutcome,
} from '@sobremesa/shared-types';
import type {
  FacilitatorActivationScenario,
  FollowupFormulationScenario,
} from '../scenarios/followup-scenarios';

/** Base "now" every scenario's relative offsets are computed against. */
function now(): number {
  return Date.now();
}

function minutesAgo(minutes: number): Date {
  return new Date(now() - minutes * 60_000);
}

// --- FollowupAgent.formulate() scenarios -----------------------------------

function makeFollowupMessage(
  scenario: FollowupFormulationScenario,
): ConversationEvent {
  return {
    id: 'evt-1',
    familyId: 'fam1',
    sequenceNumber: 10,
    source: 'telegram',
    conversationId: 'conv-1',
    externalEventId: 'ext-1',
    actorExternalId: 'actor-1',
    actorDisplayName: 'A family member',
    eventType: 'message',
    contentOriginal: scenario.messageText,
    occurredAt: new Date(),
    ingestedAt: new Date(),
  };
}

function makeFollowupFamily(): Family {
  return {
    id: 'fam1',
    name: 'Eval Family',
    config: {},
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Family;
}

/**
 * Drives the real `FollowupAgent.formulate()` for one scenario, faking only
 * its three repository-shaped dependencies and the provider turn. No live
 * LLM call -- the provider fake returns the scenario's canned response (or
 * throws), matching this plan item's "no live LLM calls in CI" constraint.
 */
export async function runFollowupFormulationScenario(
  scenario: FollowupFormulationScenario,
): Promise<FollowupResult> {
  const message = makeFollowupMessage(scenario);
  const family = makeFollowupFamily();

  const eventRepo = {
    findById: async () => message,
    findRecent: async () => [],
  };
  const familyRepo = {
    findById: async () => family,
  };
  const recordContext = {
    build: async () => ({
      block: scenario.recordBlock,
      hints: scenario.hints ?? [],
    }),
  };
  const provider: AIProvider = {
    name: 'eval-fake',
    complete: async (): Promise<AICompletionResponse> => {
      if ('throws' in scenario.provider) {
        throw new Error(scenario.provider.throws);
      }
      return {
        content: scenario.provider.content,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        model: 'eval-fake',
      };
    },
    supportsVision: () => false,
    isAvailable: async () => true,
  };

  const agent = new FollowupAgent({
    provider,
    model: 'eval-fake',
    eventRepo: eventRepo as any,
    familyRepo: familyRepo as any,
    recordContext: recordContext as any,
  });

  return agent.formulate({
    familyId: family.id,
    domainModel: {
      conversationEventId: message.id,
      detectedLanguage: scenario.detectedLanguage,
    },
  });
}

// --- FacilitatorAgent.askNextQuestion() scenarios ---------------------------

export interface LoggedEvent {
  eventType: EventLogType;
  eventCategory: EventCategory;
  eventData?: Record<string, unknown>;
}

export interface FacilitatorActivationRunResult {
  result: AskQuestionResult;
  sentMessages: Array<{ chatId: string | number; text: string }>;
  providerCallCount: number;
  loggedEvents: LoggedEvent[];
  retiredQuestionIds: string[];
  /** The pending question's final in-memory status, or `undefined` when the scenario had none. */
  finalQuestionStatus: Question['status'] | undefined;
}

/**
 * Drives the real `FacilitatorAgent.askNextQuestion()` for one scenario,
 * faking its repositories and message sender in memory. Every "minutes ago"
 * input is resolved against the real clock at call time, exactly as
 * `FacilitatorAgent` itself reads `Date.now()` -- no injected clock exists on
 * the agent today (facilitator.spec.ts uses the same convention).
 */
export async function runFacilitatorActivationScenario(
  scenario: FacilitatorActivationScenario,
): Promise<FacilitatorActivationRunResult> {
  const familyId = 'fam1';
  const loggedEvents: LoggedEvent[] = [];
  const retiredQuestionIds: string[] = [];
  const sentMessages: Array<{ chatId: string | number; text: string }> = [];
  let providerCallCount = 0;

  let question: Question | undefined = scenario.pendingQuestion
    ? {
        id: 'q1',
        familyId,
        contentOriginal: scenario.pendingQuestion.contentOriginal,
        languageOriginal: 'en',
        origin: 'followup',
        status: 'proposed',
        priority: 50,
        createdAt: minutesAgo(scenario.pendingQuestion.createdAtMinutesAgo),
        updatedAt: new Date(),
        expiresAt: scenario.pendingQuestion.expired
          ? minutesAgo(1)
          : new Date(now() + 24 * 60 * 60_000),
      }
    : undefined;

  const isExpired = (q: Question) =>
    Boolean(q.expiresAt && q.expiresAt.getTime() <= now());

  const family: Family = {
    id: familyId,
    name: 'Eval Family',
    config: { paused: scenario.paused ?? false },
    chatId: 'chat-1',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Family;

  const questionRepo = {
    findExpiredPending: async () =>
      question && question.status === 'proposed' && isExpired(question)
        ? [question]
        : [],
    findPending: async () =>
      question && question.status === 'proposed' && !isExpired(question)
        ? [question]
        : [],
    findMostRecentAskedAt: async () =>
      scenario.lastAskedMinutesAgo !== undefined
        ? minutesAgo(scenario.lastAskedMinutesAgo)
        : null,
    markAsked: async () => {
      if (question) question = { ...question, status: 'asked' };
      return question as Question;
    },
    retire: async (_familyId: string, id: string) => {
      retiredQuestionIds.push(id);
      if (question && question.id === id) {
        question = { ...question, status: 'retired' };
      }
      return question as Question;
    },
  };
  const familyRepo = { findById: async () => family };
  const eventLog = {
    log: async (entry: LoggedEvent) => {
      loggedEvents.push(entry);
      return {} as any;
    },
  };
  const familyAccessRepo = { isPersonParticipant: async () => false };
  const personRepo = { findBestMatch: async () => null };
  const conversationEventRepo = {
    findMostRecentOccurredAt: async () =>
      scenario.lastConversationEventMinutesAgo !== undefined
        ? minutesAgo(scenario.lastConversationEventMinutesAgo)
        : null,
  };
  const messageSender: MessageSender = {
    sendMessage: async (_role, message): Promise<SendOutcome> => {
      sentMessages.push({ chatId: message.chatId, text: message.text });
      return { status: 'sent', messageId: 1 };
    },
  };
  const provider: AIProvider | undefined = scenario.providerConfigured
    ? {
        name: 'eval-fake',
        complete: async (): Promise<AICompletionResponse> => {
          providerCallCount++;
          return {
            content: 'should never be reached for a followup-origin question',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            model: 'eval-fake',
          };
        },
        supportsVision: () => false,
        isAvailable: async () => true,
      }
    : undefined;

  const agent = new FacilitatorAgent({
    messageSender,
    provider,
    model: provider ? 'eval-fake' : undefined,
    questionRepo: questionRepo as any,
    familyRepo: familyRepo as any,
    eventLog: eventLog as any,
    familyAccessRepo: familyAccessRepo as any,
    personRepo: personRepo as any,
    conversationEventRepo: conversationEventRepo as any,
    minMinutesBetweenQuestions: scenario.minMinutesBetweenQuestions,
  });

  const result = await agent.askNextQuestion(familyId);

  return {
    result,
    sentMessages,
    providerCallCount,
    loggedEvents,
    retiredQuestionIds,
    finalQuestionStatus: question?.status,
  };
}
