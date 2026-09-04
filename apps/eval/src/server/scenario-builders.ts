import {
  ConversationEventRepository,
  FamilyRepository,
  type DatabaseClient,
} from '@sobremesa/database';
import type { ConversationEvent } from '@sobremesa/shared-types';
import {
  scribeEvalScenarios,
  type EvalMessage,
  type EvalSender,
  type ScribeConfig,
  type ScribeEvalScenario,
} from '@sobremesa/evals';

export const DEFAULT_REAL_CONTEXT_WINDOW = 30;

/** A previous message as edited/kept by the "new run" prompt preview, keyed by display name (see `buildRealScenario`). */
export interface ContextMessageOverride {
  senderName: string;
  text: string;
  occurredAt?: string;
}

/**
 * The three ways a run can be started (eval-site-plan.md decision #4):
 * a curated scenario (scored against its golden), ad hoc text, or a real
 * message from an imported family (both unscored — see run-scenario in
 * `apps/eval/src/server/routes/runs.ts`).
 *
 * A `real` run's context/prompt can be overridden with exactly what the "new
 * run" preview showed and the user edited (eval-tool-v2-plan.md decision #4,
 * revised): `contextOverride` replaces the DB-fetched prior-message window
 * wholesale (edited/removed messages), `scribeConfig` varies the structured
 * prompt knobs, and `systemPromptOverride`, when present, is sent verbatim
 * instead of anything `scribeConfig` would generate.
 */
export type RunInput =
  | { kind: 'scenario'; scenarioId: string }
  | { kind: 'adhoc'; text: string; senderName?: string }
  | {
      kind: 'real';
      familyId: string;
      eventId: string;
      contextWindow?: number;
      contextOverride?: ContextMessageOverride[];
      scribeConfig?: Partial<
        Pick<
          ScribeConfig,
          'thoroughness' | 'confidence' | 'scribeName' | 'primaryLanguage'
        >
      >;
      systemPromptOverride?: string;
    };

export async function buildScenario(
  input: RunInput,
  dbClient: DatabaseClient,
): Promise<ScribeEvalScenario> {
  switch (input.kind) {
    case 'scenario':
      return findCuratedScenario(input.scenarioId);
    case 'adhoc':
      return buildAdhocScenario(input.text, input.senderName);
    case 'real':
      return buildRealScenario(input, dbClient);
  }
}

function findCuratedScenario(scenarioId: string): ScribeEvalScenario {
  const scenario = scribeEvalScenarios.find((s) => s.id === scenarioId);
  if (!scenario) {
    throw new Error(`Unknown scenario: ${scenarioId}`);
  }
  return scenario;
}

function buildAdhocScenario(
  text: string,
  senderName = 'You',
): ScribeEvalScenario {
  return {
    id: `adhoc-${Date.now()}`,
    description: 'Ad hoc text',
    senders: { user: { id: 'adhoc-user', displayName: senderName } },
    messages: [{ sender: 'user', text }],
  };
}

async function buildRealScenario(
  input: Extract<RunInput, { kind: 'real' }>,
  dbClient: DatabaseClient,
): Promise<ScribeEvalScenario> {
  const eventRepo = new ConversationEventRepository(dbClient);
  const target = await eventRepo.findById(input.familyId, input.eventId);
  if (!target) {
    throw new Error(`Event not found: ${input.eventId}`);
  }

  const contextWindow = input.contextWindow ?? DEFAULT_REAL_CONTEXT_WINDOW;

  const senders: Record<string, EvalSender> = {};
  const registerSender = (event: ConversationEvent) => {
    if (!senders[event.actorExternalId]) {
      senders[event.actorExternalId] = {
        id: event.actorExternalId,
        displayName: event.actorDisplayName || event.actorUsername || 'Unknown',
        username: event.actorUsername,
      };
    }
  };
  registerSender(target);

  let initialContext: EvalMessage[];
  if (input.contextOverride) {
    // Edited/removed by the "new run" preview — the exact prior-message
    // window sent, not what's currently in the DB. Keyed by display name
    // (not a real `actorExternalId`): this is a synthetic in-memory replay
    // (see `runScenario`/`buildScenarioPrompt`), and Scribe never resolves
    // sender identity beyond the name it puts in the prompt.
    for (const message of input.contextOverride) {
      senders[message.senderName] ??= {
        id: message.senderName,
        displayName: message.senderName,
      };
    }
    initialContext = input.contextOverride.map((message) => ({
      sender: message.senderName,
      text: message.text,
      occurredAt: message.occurredAt
        ? new Date(message.occurredAt)
        : new Date(),
    }));
  } else {
    const priorDesc = await eventRepo.findRecent(
      input.familyId,
      target.conversationId,
      contextWindow,
      false,
      target.sequenceNumber,
    );
    const prior = [...priorDesc].reverse();
    for (const event of prior) registerSender(event);
    initialContext = prior.map(toEvalMessage);
  }

  const familyRepo = new FamilyRepository(dbClient);
  const family = await familyRepo.findById(input.familyId);
  const familyConfigRaw = (family?.config ?? {}) as Record<string, unknown>;

  return {
    id: `real-${input.eventId}`,
    description: `Real message ${input.eventId} (family ${input.familyId})`,
    senders,
    initialContext,
    messages: [toEvalMessage(target)],
    contextWindow,
    familyConfig: {
      timezone:
        typeof familyConfigRaw.timezone === 'string'
          ? familyConfigRaw.timezone
          : undefined,
      culturalTerms: Array.isArray(familyConfigRaw.culturalTerms)
        ? familyConfigRaw.culturalTerms
        : [],
    },
  };
}

function toEvalMessage(event: ConversationEvent): EvalMessage {
  return {
    sender: event.actorExternalId,
    text: event.contentOriginal ?? '',
    // `occurredAt` is typed `Date` on `ConversationEvent`, but the repository
    // mapper (`mapRowToCamelCase`) doesn't parse it — it arrives as a raw
    // ISO string from Supabase. `runScenario`'s context builder sorts by
    // `.getTime()`, so this must be a real `Date` before it gets there.
    occurredAt: new Date(event.occurredAt),
  };
}
