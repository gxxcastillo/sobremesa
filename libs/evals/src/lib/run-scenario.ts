import {
  ScribeAgent,
  type ScribeConfig,
  type ScribePromptBuild,
} from '@sobremesa/agents-scribe';
import type { AICompletionResponse, AIProvider } from '@sobremesa/ai-provider';
import type {
  ConversationEventRepository,
  FamilyRepository,
  ImageRepository,
} from '@sobremesa/database';
import type { MessageContext } from '@sobremesa/queue';
import { createLogger } from '@sobremesa/shared-utils';
import {
  DEFAULT_FACILITATOR_NAME,
  type ChatProvider,
  type ConversationEvent,
  type Family,
  type Image,
  type ScribeDomainModel,
} from '@sobremesa/shared-types';
import {
  DEFAULT_CONTEXT_WINDOW,
  type EvalMessage,
  type EvalSender,
  type ScenarioRunResult,
  type ScribeEvalScenario,
} from './scenario';

/**
 * Base timestamp scenario events are offset from, so scenario runs are
 * reproducible across invocations (no wall-clock dependence in evidence
 * grounding or context ordering).
 */
export const DEFAULT_BASE_TIME = new Date('2026-01-15T18:00:00.000Z');

export class InMemoryEventRepository {
  constructor(private readonly events: ConversationEvent[]) {}

  async findById(
    familyId: string,
    id: string,
  ): Promise<ConversationEvent | null> {
    return (
      this.events.find(
        (event) => event.familyId === familyId && event.id === id,
      ) ?? null
    );
  }

  async findRecent(
    familyId: string,
    conversationId: string,
    limit = DEFAULT_CONTEXT_WINDOW,
    _includeProcessing = false,
    beforeSequenceNumber?: number,
  ): Promise<ConversationEvent[]> {
    // In-memory eval events do not carry processing joins, but preserve the
    // production repository's positional API so callers behave identically.
    void _includeProcessing;
    return this.events
      .filter(
        (event) =>
          event.familyId === familyId &&
          event.conversationId === conversationId &&
          event.contentOriginal &&
          (beforeSequenceNumber === undefined ||
            (event.sequenceNumber ?? 0) < beforeSequenceNumber),
      )
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
      .slice(0, limit);
  }
}

export class InMemoryFamilyRepository {
  constructor(private readonly family: Family) {}

  async findById(id: string): Promise<Family | null> {
    return id === this.family.id ? this.family : null;
  }
}

export class EmptyImageRepository {
  async findRecentInConversation(): Promise<Image[]> {
    return [];
  }
}

export function makeFamily(scenario: ScribeEvalScenario): Family {
  const now = new Date(DEFAULT_BASE_TIME);
  return {
    id: `eval-family-${scenario.id}`,
    name: `Eval Family ${scenario.id}`,
    config: {
      culturalTerms: scenario.familyConfig?.culturalTerms ?? [],
      ...(scenario.familyConfig?.timezone
        ? { timezone: scenario.familyConfig.timezone }
        : {}),
    },
    chatId: `eval-chat-${scenario.id}`,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  } as Family;
}

export function createEvent(options: {
  scenario: ScribeEvalScenario;
  message: EvalMessage;
  sender: EvalSender;
  sequenceNumber: number;
  occurredAt: Date;
  externalReplyToId?: string;
}): ConversationEvent {
  return {
    id: `${options.scenario.id}-${options.sequenceNumber}`,
    familyId: `eval-family-${options.scenario.id}`,
    sequenceNumber: options.sequenceNumber,
    source: 'telegram' satisfies ChatProvider,
    conversationId: `eval-chat-${options.scenario.id}`,
    externalEventId: `eval-message-${options.sequenceNumber}`,
    externalReplyToId: options.externalReplyToId,
    actorExternalId: options.sender.id,
    actorDisplayName: options.sender.displayName,
    actorUsername: options.sender.username,
    eventType: 'message',
    contentOriginal: options.message.text,
    languageOriginal: 'unknown',
    metadata: {},
    sourcePayload: {},
    occurredAt: options.message.occurredAt ?? options.occurredAt,
    ingestedAt: options.message.occurredAt ?? options.occurredAt,
  };
}

export function makeContext(
  events: ConversationEvent[],
  current: ConversationEvent,
  windowSize: number,
  currentMessage: EvalMessage,
): MessageContext {
  // Deliberately count-truncated for the existing Scribe suite. Its grounding
  // scorer depends on this exact context; use makeProcessorContext for new
  // pipeline-faithful evals until the Scribe baseline is formally recorded.
  return buildContext(
    events,
    current,
    currentMessage,
    events
      .filter(
        (event) =>
          event.conversationId === current.conversationId &&
          event.sequenceNumber !== undefined &&
          current.sequenceNumber !== undefined &&
          event.sequenceNumber < current.sequenceNumber &&
          event.contentOriginal,
      )
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
      .slice(0, windowSize)
      .reverse(),
  );
}

/**
 * Build the same 2,500-character, newest-first-then-reversed context that
 * MessageProcessor.fetchContext supplies to production Intern.
 */
export function makeProcessorContext(
  events: ConversationEvent[],
  current: ConversationEvent,
  currentMessage: EvalMessage,
  options?: { maxContextChars?: number },
): MessageContext {
  const maxContextChars = options?.maxContextChars ?? 2500;
  const candidates = events
    .filter(
      (event) =>
        event.conversationId === current.conversationId &&
        event.sequenceNumber !== undefined &&
        current.sequenceNumber !== undefined &&
        event.sequenceNumber < current.sequenceNumber &&
        event.contentOriginal,
    )
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
    .slice(0, DEFAULT_CONTEXT_WINDOW);

  const selected: ConversationEvent[] = [];
  let totalChars = 0;
  for (const event of candidates) {
    const content = event.contentOriginal ?? '';
    if (totalChars + content.length > maxContextChars && selected.length > 0) {
      break;
    }
    selected.push(event);
    totalChars += content.length;
  }

  return buildContext(events, current, currentMessage, selected.reverse());
}

function buildContext(
  events: ConversationEvent[],
  current: ConversationEvent,
  currentMessage: EvalMessage,
  recentEvents: ConversationEvent[],
): MessageContext {
  const recentMessages = recentEvents.map((event) => ({
    id: event.id,
    content: event.contentOriginal ?? '',
    senderName: event.actorDisplayName ?? event.actorUsername ?? 'Unknown',
    occurredAt: event.occurredAt,
  }));

  const replyToEvent = current.externalReplyToId
    ? events.find(
        (event) =>
          event.conversationId === current.conversationId &&
          event.externalEventId === current.externalReplyToId &&
          event.contentOriginal,
      )
    : undefined;

  return {
    recentMessages,
    replyToMessage: replyToEvent
      ? {
          id: replyToEvent.id,
          content: replyToEvent.contentOriginal ?? '',
          senderName:
            replyToEvent.actorDisplayName ||
            replyToEvent.actorUsername ||
            'Unknown',
          occurredAt: replyToEvent.occurredAt,
        }
      : undefined,
    answeredQuestion: currentMessage.answeredQuestion
      ? {
          id: `${current.id}-question`,
          content: currentMessage.answeredQuestion.content,
          askedByName:
            currentMessage.answeredQuestion.askedByName ??
            DEFAULT_FACILITATOR_NAME,
        }
      : undefined,
    recentImages: [],
  };
}

export function getSender(
  scenario: ScribeEvalScenario,
  senderKey: string,
): EvalSender {
  const sender = scenario.senders[senderKey];
  if (!sender) {
    throw new Error(
      `Scenario ${scenario.id} references unknown sender ${senderKey}`,
    );
  }
  return sender;
}

export function offsetTime(sequenceNumber: number): Date {
  return new Date(DEFAULT_BASE_TIME.getTime() + sequenceNumber * 2_000);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Never actually called — `buildScenarioPrompt` only builds the prompt, it never completes it. */
const UNUSED_PROVIDER: AIProvider = {
  name: 'preview-only',
  async complete(): Promise<AICompletionResponse> {
    throw new Error('buildScenarioPrompt never calls the provider');
  },
  supportsVision: () => false,
  async isAvailable() {
    return false;
  },
};

/**
 * Optional per-run overrides layered onto a scenario's default Scribe
 * behavior. `config` varies the structured knobs (thoroughness, confidence,
 * etc.); `systemPromptOverride`, when set, is sent verbatim instead of the
 * prompt `config` would generate — an eval-only escape hatch
 * (`ScribeAgentEvalOptions.systemPromptOverride`), never used by the live
 * pipeline.
 */
export interface RunScenarioOptions {
  config?: Partial<ScribeConfig>;
  systemPromptOverride?: string;
}

/**
 * Run one scenario through a real `ScribeAgent` against in-memory repos —
 * shared by the CLI runner (`runners/scribe-evals.ts`) and `apps/eval`'s
 * backend, so both exercise the exact same extraction plumbing.
 */
export async function runScenario(
  scenario: ScribeEvalScenario,
  provider: AIProvider,
  model: string,
  options?: RunScenarioOptions,
): Promise<ScenarioRunResult> {
  const family = makeFamily(scenario);
  const events: ConversationEvent[] = [];
  const eventRepo = new InMemoryEventRepository(events);
  const familyRepo = new InMemoryFamilyRepository(family);
  const imageRepo = new EmptyImageRepository();
  const logger = createLogger({
    name: `evals-scribe-${scenario.id}`,
    level: 'warn',
    pretty: false,
  });

  const scribe = ScribeAgent.forEval({
    provider,
    model,
    eventRepo: eventRepo as unknown as ConversationEventRepository,
    familyRepo: familyRepo as unknown as FamilyRepository,
    imageRepo: imageRepo as unknown as ImageRepository,
    logger,
    config: options?.config,
    systemPromptOverride: options?.systemPromptOverride,
  });

  let sequenceNumber = 1;
  for (const message of scenario.initialContext ?? []) {
    events.push(
      createEvent({
        scenario,
        message,
        sender: getSender(scenario, message.sender),
        sequenceNumber,
        occurredAt: offsetTime(sequenceNumber),
      }),
    );
    sequenceNumber++;
  }

  const outputs: ScribeDomainModel[] = [];
  try {
    for (const message of scenario.messages) {
      const event = createEvent({
        scenario,
        message,
        sender: getSender(scenario, message.sender),
        sequenceNumber,
        occurredAt: offsetTime(sequenceNumber),
        externalReplyToId:
          message.replyTo !== undefined
            ? `eval-message-${message.replyTo + 1}`
            : undefined,
      });
      events.push(event);

      const context = makeContext(
        events,
        event,
        scenario.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        message,
      );
      const output = await scribe.process(event.id, family.id, context);
      outputs.push(output);
      sequenceNumber++;
    }
  } catch (error) {
    return {
      scenario,
      outputs,
      error: toError(error),
    };
  }

  return {
    scenario,
    outputs,
  };
}

/**
 * Build the exact system/user prompt a run of `scenario.messages[0]` would
 * send, without calling any provider — backs `apps/eval`'s "new run"
 * real-message preview and prompt editor. Only supports single-message
 * scenarios (real-message and ad hoc input each always build exactly one);
 * a scenario with more than one message throws, since "the prompt for
 * message N" needs every message before it already applied through
 * `scribe.process()`, which only `runScenario` itself does.
 */
export async function buildScenarioPrompt(
  scenario: ScribeEvalScenario,
  config?: Partial<ScribeConfig>,
): Promise<ScribePromptBuild> {
  if (scenario.messages.length !== 1) {
    throw new Error(
      `buildScenarioPrompt only supports single-message scenarios (got ${scenario.messages.length})`,
    );
  }

  const family = makeFamily(scenario);
  const events: ConversationEvent[] = [];
  const eventRepo = new InMemoryEventRepository(events);
  const familyRepo = new InMemoryFamilyRepository(family);
  const imageRepo = new EmptyImageRepository();
  const logger = createLogger({
    name: `evals-scribe-preview-${scenario.id}`,
    level: 'warn',
    pretty: false,
  });

  const scribe = new ScribeAgent({
    provider: UNUSED_PROVIDER,
    model: 'preview',
    eventRepo: eventRepo as unknown as ConversationEventRepository,
    familyRepo: familyRepo as unknown as FamilyRepository,
    imageRepo: imageRepo as unknown as ImageRepository,
    logger,
    config,
  });

  let sequenceNumber = 1;
  for (const message of scenario.initialContext ?? []) {
    events.push(
      createEvent({
        scenario,
        message,
        sender: getSender(scenario, message.sender),
        sequenceNumber,
        occurredAt: offsetTime(sequenceNumber),
      }),
    );
    sequenceNumber++;
  }

  const message = scenario.messages[0];
  const event = createEvent({
    scenario,
    message,
    sender: getSender(scenario, message.sender),
    sequenceNumber,
    occurredAt: offsetTime(sequenceNumber),
    externalReplyToId:
      message.replyTo !== undefined
        ? `eval-message-${message.replyTo + 1}`
        : undefined,
  });
  events.push(event);

  const context = makeContext(
    events,
    event,
    scenario.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    message,
  );

  return scribe.buildPrompt(event.id, family.id, context);
}
