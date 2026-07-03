#!/usr/bin/env bun
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import {
  DEFAULT_MODELS,
  createAIProviderFactory,
  loadAIConfig,
  type AIConfig,
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
import { buildReport, buildSuiteReport } from '../lib/scorer';
import type {
  EvalMessage,
  EvalSender,
  EvalReport,
  EvalSuiteReport,
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
  providerNames: string[];
  list: boolean;
  json: boolean;
}

interface ProviderSetup {
  id: string;
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
    providerNames: [],
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
      case '--provider':
        options.providerNames.push(argv[++index]);
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
  bun nx run evals:run -- --provider anthropic --provider local
  bun nx run evals:run -- --threshold 0.85 --json

Options:
  --list              List available scenarios.
  --scenario <id>     Run only one scenario. Repeat to run several.
  --provider <name>   Live provider to run: anthropic or local. Repeat to run both.
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

function createProviders(options: CliOptions): ProviderSetup[] {
  const config = loadAIConfig(process.env);
  const anthropicClient = process.env['ANTHROPIC_API_KEY']
    ? new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] })
    : undefined;
  const factory = createAIProviderFactory(config, anthropicClient);
  const providerNames =
    options.providerNames.length > 0
      ? options.providerNames
      : ['anthropic', 'local'].filter(
          (providerName) => config.providers[providerName],
        );

  if (providerNames.length === 0) {
    throw new Error(
      'Tier-1 Scribe evals require a live provider. Set ANTHROPIC_API_KEY or LOCAL_LLM_BASE_URL.',
    );
  }

  return providerNames.map((providerName) => {
    if (providerName === 'mock') {
      throw new Error('Tier-1 Scribe evals do not run against mock provider.');
    }
    if (!config.providers[providerName]) {
      throw new Error(`Provider is not configured: ${providerName}`);
    }

    return {
      id: providerName,
      provider: factory.getProvider(providerName),
      model: getScribeModel(config, providerName),
    };
  });
}

function getScribeModel(config: AIConfig, providerName: string): string {
  const agentModel = config.agentModels.scribe;
  if (agentModel?.provider === providerName) {
    return agentModel.model;
  }

  const provider = config.providers[providerName];
  if (provider?.defaultModel) {
    return provider.defaultModel;
  }
  if (provider?.type === 'anthropic') {
    return DEFAULT_MODELS.anthropic.standard;
  }
  if (provider?.type === 'openai-compatible') {
    return DEFAULT_MODELS.local.standard;
  }

  return 'unknown';
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

function printSuiteReport(report: EvalSuiteReport): void {
  if (report.reports.length === 1) {
    printReport(report.reports[0]);
    return;
  }

  const providers = report.reports.map((providerReport) => ({
    id: providerReport.provider,
    label: providerReport.provider.slice(0, 10),
    byScenario: new Map(
      providerReport.scenarioScores.map((score) => [score.scenarioId, score]),
    ),
  }));
  const candidate = providers.find(
    (provider) => provider.id !== report.baselineProvider,
  );
  const gapByScenario = new Map(
    report.capabilityGaps.map((gap) => [gap.scenarioId, gap.gap]),
  );

  console.log('Scribe Evaluation Report');
  console.log(`Generated: ${report.generatedAt.toISOString()}`);
  console.log(`Threshold: ${formatScore(report.threshold)}`);
  console.log(`Baseline:  ${report.baselineProvider}`);
  console.log('');
  console.log('Providers:');
  for (const column of report.providerColumns) {
    console.log(
      `  ${column.provider}: ${column.model} aggregate ${formatScore(
        column.aggregateScore,
      )} precision ${formatScore(column.aggregatePrecision)} recall ${formatScore(
        column.aggregateRecall,
      )} ${column.passed ? 'PASS' : 'FAIL'}`,
    );
  }
  if (report.aggregateCapabilityGap !== undefined && candidate) {
    console.log(
      `Capability gap (${report.baselineProvider} - ${candidate.id}): ${formatScore(
        report.aggregateCapabilityGap,
      )}`,
    );
  } else {
    console.log('Capability gap: n/a (run anthropic and local together)');
  }
  console.log('');

  const providerHeaders = providers
    .map((provider) => provider.label.padStart(10))
    .join('  ');
  console.log(
    `Scenario                           ${providerHeaders}       Gap`,
  );
  console.log(
    '----------------------------------------------------------------',
  );

  const scenarioIds = report.reports[0].scenarioScores.map(
    (score) => score.scenarioId,
  );
  for (const scenarioId of scenarioIds) {
    const scores = providers
      .map((provider) =>
        formatScore(provider.byScenario.get(scenarioId)?.score ?? 0).padStart(
          10,
        ),
      )
      .join('  ');
    const gap =
      report.aggregateCapabilityGap !== undefined
        ? formatScore(gapByScenario.get(scenarioId) ?? 0).padStart(8)
        : '     n/a';
    console.log(`${scenarioId.padEnd(34)} ${scores}  ${gap}`);
  }
  console.log(
    '----------------------------------------------------------------',
  );
  console.log(`Suite result: ${report.passed ? 'PASS' : 'FAIL'}`);

  for (const providerReport of report.reports) {
    for (const scenario of providerReport.scenarioScores) {
      const missing = scenario.categories.flatMap((category) =>
        category.missing.map(
          (item) => `${providerReport.provider}/${category.category}: ${item}`,
        ),
      );
      for (const item of missing) {
        console.log(`  missing ${item}`);
      }
      for (const hit of scenario.forbiddenHits) {
        console.log(
          `  forbidden ${providerReport.provider}/${hit.category}: expected no "${hit.expected}", saw "${hit.actual}"`,
        );
      }
    }
  }
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
  const providers = createProviders(options);
  const reports: EvalReport[] = [];

  for (const providerSetup of providers) {
    const results: ScenarioRunResult[] = [];
    for (const scenario of scenarios) {
      console.log(`Running ${providerSetup.id}/${scenario.id}...`);
      results.push(
        await runScenario(
          scenario,
          providerSetup.provider,
          providerSetup.model,
        ),
      );
    }

    reports.push(
      buildReport({
        results,
        provider: providerSetup.id,
        model: providerSetup.model,
        threshold: options.threshold,
      }),
    );
  }

  const report = buildSuiteReport({
    reports,
    threshold: options.threshold,
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printSuiteReport(report);
  }

  if (!report.passed) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(toError(error).message);
  process.exit(1);
});
