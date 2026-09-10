import { InternAgent, type RoutingAction } from '@sobremesa/agents-intern';
import type { AIProvider } from '@sobremesa/ai-provider';
import type {
  ConversationEventRepository,
  ImageRepository,
} from '@sobremesa/database';
import { createLogger } from '@sobremesa/shared-utils';
import type { LanguageCode, ConversationEvent } from '@sobremesa/shared-types';
import {
  createEvent,
  EmptyImageRepository,
  getSender,
  InMemoryEventRepository,
  makeFamily,
  makeProcessorContext,
  offsetTime,
} from './run-scenario';
import type { ScribeEvalScenario } from './scenario';

export interface InternDecisionRecord {
  messageIndex: number;
  action: RoutingAction;
  adminSubtype?: string;
  relevant: boolean | null;
  reason: string;
  language?: LanguageCode;
  tokensUsed?: number;
  calledModel: boolean;
}

export interface InternScenarioRunResult {
  scenario: ScribeEvalScenario;
  decisions: InternDecisionRecord[];
  error?: Error;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Run Intern's real route() once per message against in-memory events. */
export async function runInternScenario(
  scenario: ScribeEvalScenario,
  provider: AIProvider,
  model: string,
): Promise<InternScenarioRunResult> {
  const family = makeFamily(scenario);
  const events: ConversationEvent[] = [];
  const eventRepo = new InMemoryEventRepository(events);
  const intern = new InternAgent({
    provider,
    model,
    eventRepo: eventRepo as unknown as ConversationEventRepository,
    imageRepo: new EmptyImageRepository() as unknown as ImageRepository,
    logger: createLogger({
      name: `evals-intern-${scenario.id}`,
      level: 'warn',
      pretty: false,
    }),
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

  const decisions: InternDecisionRecord[] = [];
  try {
    for (const [messageIndex, message] of scenario.messages.entries()) {
      const event = createEvent({
        scenario,
        message,
        sender: getSender(scenario, message.sender),
        sequenceNumber,
        occurredAt: offsetTime(sequenceNumber),
        externalReplyToId:
          message.replyTo === undefined
            ? undefined
            : `eval-message-${message.replyTo + 1}`,
      });
      events.push(event);
      const route = await intern.route(
        event.id,
        family.id,
        makeProcessorContext(events, event, message),
      );
      decisions.push({
        messageIndex,
        action: route.action,
        adminSubtype: route.adminSubtype,
        relevant: route.action === 'admin' ? null : route.action !== 'ignore',
        reason: route.reason,
        language: route.language,
        tokensUsed: route.tokensUsed,
        calledModel: route.tokensUsed !== undefined,
      });
      sequenceNumber++;
    }
  } catch (error) {
    return { scenario, decisions, error: toError(error) };
  }
  return { scenario, decisions };
}
