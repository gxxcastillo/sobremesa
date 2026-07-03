#!/usr/bin/env bun
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import {
  createAIProviderFactory,
  loadAIConfig,
  type AIProvider,
} from '@sobremesa/ai-provider';
import { ScribeAgent } from '@sobremesa/agents-scribe';
import type {
  ConversationEventRepository,
  FamilyRepository,
  ImageRepository,
} from '@sobremesa/database';
import type { MessageContext } from '@sobremesa/queue';
import { createLogger } from '@sobremesa/shared-utils';
import type {
  ChatProvider,
  ConversationEvent,
  Family,
  Image,
  ScribeDomainModel,
} from '@sobremesa/shared-types';
import { buildReport } from '../lib/scorer';
import type {
  EvalMessage,
  EvalSender,
  EvalReport,
  ScenarioRunResult,
  ScribeEvalScenario,
} from '../lib/scenario';
import { scribeEvalScenarios } from '../scenarios/scribe-scenarios';

const DEFAULT_THRESHOLD = 0.8;
const DEFAULT_BASE_TIME = new Date('2026-01-15T18:00:00.000Z');
const DEFAULT_CONTEXT_WINDOW = 30;

interface CliOptions {
  threshold: number;
  scenarioIds: string[];
  list: boolean;
  json: boolean;
}

interface ProviderSetup {
  provider: AIProvider;
  model: string;
}

class InMemoryEventRepository {
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
    beforeSequenceNumber?: number,
  ): Promise<ConversationEvent[]> {
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

class InMemoryFamilyRepository {
  constructor(private readonly family: Family) {}

  async findById(id: string): Promise<Family | null> {
    return id === this.family.id ? this.family : null;
  }
}

class EmptyImageRepository {
  async findRecentInConversation(): Promise<Image[]> {
    return [];
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    threshold: DEFAULT_THRESHOLD,
    scenarioIds: [],
    list: false,
    json: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case '--threshold':
        options.threshold = Number(argv[++index]);
        if (!Number.isFinite(options.threshold)) {
          throw new Error('--threshold must be a number');
        }
        break;
      case '--scenario':
        options.scenarioIds.push(argv[++index]);
        break;
      case '--list':
        options.list = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printUsage(): void {
  console.log(`Usage:
  bun nx run evals:run
  bun nx run evals:run -- --scenario bot-question-answer
  bun nx run evals:run -- --threshold 0.85 --json

Options:
  --list              List available scenarios.
  --scenario <id>     Run only one scenario. Repeat to run several.
  --threshold <n>     Aggregate pass threshold. Default: ${DEFAULT_THRESHOLD}.
  --json              Print the report as JSON.`);
}

function selectScenarios(options: CliOptions): ScribeEvalScenario[] {
  if (options.scenarioIds.length === 0) {
    return scribeEvalScenarios;
  }

  const selected = scribeEvalScenarios.filter((scenario) =>
    options.scenarioIds.includes(scenario.id),
  );
  const selectedIds = new Set(selected.map((scenario) => scenario.id));
  const missing = options.scenarioIds.filter((id) => !selectedIds.has(id));
  if (missing.length > 0) {
    throw new Error(`Unknown scenario(s): ${missing.join(', ')}`);
  }
  return selected;
}

function createProvider(): ProviderSetup {
  const config = loadAIConfig(process.env);
  const anthropicClient = process.env['ANTHROPIC_API_KEY']
    ? new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] })
    : undefined;
  const factory = createAIProviderFactory(config, anthropicClient);
  const provider = factory.getProviderForAgent('scribe');
  const model = factory.getModelForAgent('scribe');

  if (provider.name === 'mock') {
    throw new Error(
      'Tier-1 Scribe evals require a live provider. Set ANTHROPIC_API_KEY or LOCAL_LLM_BASE_URL.',
    );
  }

  return { provider, model };
}

function makeFamily(scenario: ScribeEvalScenario): Family {
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

function createEvent(options: {
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

function makeContext(
  events: ConversationEvent[],
  current: ConversationEvent,
  windowSize: number,
): MessageContext {
  const recentMessages = events
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
    .map((event) => ({
      id: event.id,
      content: event.contentOriginal ?? '',
      senderName: event.actorDisplayName ?? event.actorUsername ?? 'Unknown',
      occurredAt: event.occurredAt,
    }));

  return {
    recentMessages,
    recentImages: [],
  };
}

async function runScenario(
  scenario: ScribeEvalScenario,
  provider: AIProvider,
  model: string,
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

  const scribe = new ScribeAgent({
    provider,
    model,
    eventRepo: eventRepo as unknown as ConversationEventRepository,
    familyRepo: familyRepo as unknown as FamilyRepository,
    imageRepo: imageRepo as unknown as ImageRepository,
    logger,
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

function getSender(
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

function offsetTime(sequenceNumber: number): Date {
  return new Date(DEFAULT_BASE_TIME.getTime() + sequenceNumber * 2_000);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function printScenarioList(): void {
  console.log('Available Scribe eval scenarios:\n');
  for (const scenario of scribeEvalScenarios) {
    console.log(`  ${scenario.id}`);
    console.log(`    ${scenario.description}`);
    console.log(
      `    ${scenario.messages.length} message(s), ${(scenario.initialContext ?? []).length} context message(s)\n`,
    );
  }
}

function printReport(report: EvalReport): void {
  console.log('Scribe Evaluation Report');
  console.log(`Generated: ${report.generatedAt.toISOString()}`);
  console.log(`Provider:  ${report.provider}`);
  console.log(`Model:     ${report.model}`);
  console.log(`Threshold: ${formatScore(report.threshold)}`);
  console.log(
    `Baseline:  ${formatScore(report.aggregateScore)} (record this first real run as the initial baseline)`,
  );
  console.log('');
  console.log(
    'Scenario                           Score  Prec   Recall  Result',
  );
  console.log(
    '----------------------------------------------------------------',
  );
  for (const scenario of report.scenarioScores) {
    console.log(
      `${scenario.scenarioId.padEnd(34)} ${formatScore(scenario.score).padStart(5)}  ${formatScore(
        scenario.precision,
      ).padStart(5)}  ${formatScore(scenario.recall).padStart(6)}  ${
        scenario.passed ? 'PASS' : 'FAIL'
      }`,
    );
    const missing = scenario.categories.flatMap((category) =>
      category.missing.map((item) => `${category.category}: ${item}`),
    );
    for (const item of missing) {
      console.log(`  missing ${item}`);
    }
    for (const hit of scenario.forbiddenHits) {
      console.log(
        `  forbidden ${hit.category}: expected no "${hit.expected}", saw "${hit.actual}"`,
      );
    }
  }
  console.log(
    '----------------------------------------------------------------',
  );
  console.log(
    `Aggregate ${formatScore(report.aggregateScore)} precision ${formatScore(
      report.aggregatePrecision,
    )} recall ${formatScore(report.aggregateRecall)}: ${
      report.passed ? 'PASS' : 'FAIL'
    }`,
  );
}

function formatScore(value: number): string {
  return value.toFixed(2);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    printScenarioList();
    return;
  }

  const scenarios = selectScenarios(options);
  const { provider, model } = createProvider();
  const results: ScenarioRunResult[] = [];

  for (const scenario of scenarios) {
    console.log(`Running ${scenario.id}...`);
    results.push(await runScenario(scenario, provider, model));
  }

  const report = buildReport({
    results,
    provider: provider.name,
    model,
    threshold: options.threshold,
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  if (!report.passed) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(toError(error).message);
  process.exit(1);
});
