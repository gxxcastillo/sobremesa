#!/usr/bin/env bun
import 'dotenv/config';
import { MockProvider } from '@sobremesa/ai-provider';
import { ScribeAgent } from '@sobremesa/agents-scribe';
import { RegistrarAgent } from '@sobremesa/agents-registrar';
import {
  ProcessingQueueRepository,
  createDatabaseClient,
  type DatabaseClient,
} from '@sobremesa/database';
import { MessageProcessor } from '@sobremesa/queue';
import { createLogger } from '@sobremesa/shared-utils';
import { selectScenarios, type EvalSender } from '../lib/scenario';
import {
  compareStableSnapshots,
  readStablePipelineSnapshot,
  type StablePipelineSnapshot,
} from '../lib/pipeline-snapshot';
import {
  pipelineSnapshotScenarios,
  type PipelineSnapshotMessage,
  type PipelineSnapshotScenario,
} from '../scenarios/pipeline-scenarios';

const DEFAULT_BASE_TIME = new Date('2026-01-15T18:00:00.000Z');

interface CliOptions {
  scenarioIds: string[];
  list: boolean;
  json: boolean;
  keepFamily: boolean;
  allowRemoteDb: boolean;
}

interface ScenarioResult {
  scenarioId: string;
  description: string;
  familyId: string;
  passed: boolean;
  mismatches: string[];
  actual: StablePipelineSnapshot;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    scenarioIds: [],
    list: false,
    json: false,
    keepFamily: false,
    allowRemoteDb: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case '--scenario':
        options.scenarioIds.push(argv[++index]);
        break;
      case '--list':
        options.list = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--keep-family':
        options.keepFamily = true;
        break;
      case '--allow-remote-db':
        options.allowRemoteDb = true;
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
  bun nx run evals:pipeline
  bun nx run evals:pipeline -- --scenario pipeline-family-history
  bun nx run evals:pipeline -- --keep-family

Options:
  --list              List available Tier-2 scenarios.
  --scenario <id>     Run only one scenario. Repeat to run several.
  --json              Print the report as JSON.
  --keep-family       Keep the eval family in the database for inspection.
  --allow-remote-db   Permit running against a non-local SUPABASE_URL.`);
}

function createDbClient(options: CliOptions): DatabaseClient {
  const url = process.env['SUPABASE_URL'];
  const anonKey = process.env['SUPABASE_ANON_KEY'];
  const serviceRoleKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (!url || !anonKey || !serviceRoleKey) {
    throw new Error(
      'Tier-2 pipeline snapshots require SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY.',
    );
  }

  if (!options.allowRemoteDb && !isLocalSupabaseUrl(url)) {
    throw new Error(
      'Refusing to run Tier-2 snapshots against a non-local SUPABASE_URL. Use --allow-remote-db only for an intentional disposable database.',
    );
  }

  return createDatabaseClient({
    url,
    anonKey,
    serviceRoleKey,
  });
}

function isLocalSupabaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
}

function printScenarioList(): void {
  console.log('Available pipeline snapshot scenarios:\n');
  for (const scenario of pipelineSnapshotScenarios) {
    console.log(`  ${scenario.id}`);
    console.log(`    ${scenario.description}`);
    console.log(`    ${scenario.messages.length} message(s)\n`);
  }
}

async function runScenario(
  client: DatabaseClient,
  scenario: PipelineSnapshotScenario,
  options: CliOptions,
): Promise<ScenarioResult> {
  const family = await createFamily(client, scenario);
  try {
    const provider = createCannedProvider(scenario);
    const logger = createLogger({
      name: `evals-pipeline-${scenario.id}`,
      level: 'warn',
      pretty: false,
    });
    const scribe = new ScribeAgent({
      dbClient: client,
      provider,
      model: 'mock-canned-scribe',
      logger,
    });
    const registrar = new RegistrarAgent({
      dbClient: client,
      logger,
    });
    const processor = new MessageProcessor({ dbClient: client });
    processor.setScribe((eventId, familyId, context, preprocessed) =>
      scribe.process(eventId, familyId, context, preprocessed),
    );
    processor.setRegistrar((domainModel, familyId, versions, contextContents) =>
      registrar.persist(domainModel, familyId, versions, contextContents),
    );
    processor.setPipelineVersions({ scribeVersion: 'canned' });

    const queueRepo = new ProcessingQueueRepository(client);
    for (let index = 0; index < scenario.messages.length; index++) {
      const message = scenario.messages[index];
      const eventId = await insertConversationEvent(
        client,
        family.id,
        scenario,
        message,
        index,
      );
      const queueItem = await queueRepo.enqueue(family.id, eventId);
      const result = await processor.process(eventId, family.id);
      // processor.process() only reports success/failure; the caller owns
      // completing/failing the queue item (see libs/queue MessageQueue).
      if (result.success) {
        await queueRepo.complete(family.id, queueItem.id);
      } else {
        await queueRepo.fail(
          family.id,
          queueItem.id,
          result.error ?? 'unknown error',
        );
        throw new Error(
          `Message ${index + 1} failed processing: ${result.error ?? 'unknown error'}`,
        );
      }
    }

    const actual = await readStablePipelineSnapshot(client, family.id);
    const comparison = compareStableSnapshots(actual, scenario.expected);
    return {
      scenarioId: scenario.id,
      description: scenario.description,
      familyId: family.id,
      passed: comparison.passed,
      mismatches: comparison.mismatches,
      actual,
    };
  } finally {
    if (!options.keepFamily) {
      await deleteFamily(client, family.id);
    }
  }
}

async function createFamily(
  client: DatabaseClient,
  scenario: PipelineSnapshotScenario,
): Promise<{ id: string }> {
  const chatId = `eval-pipeline-${scenario.id}-${Date.now()}`;
  const { data, error } = await client
    .from('families')
    .insert({
      name: `Eval Pipeline | ${scenario.id}`,
      chat_source: 'telegram',
      chat_id: chatId,
      config: scenario.familyConfig ?? {},
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`Failed to create eval family: ${error?.message}`);
  }

  return { id: String(data.id) };
}

async function deleteFamily(
  client: DatabaseClient,
  familyId: string,
): Promise<void> {
  const { error } = await client.rpc('delete_family_cascade', {
    p_family_id: familyId,
  });
  if (error) {
    throw new Error(
      `Failed to delete eval family ${familyId}: ${error.message}`,
    );
  }
}

async function insertConversationEvent(
  client: DatabaseClient,
  familyId: string,
  scenario: PipelineSnapshotScenario,
  message: PipelineSnapshotMessage,
  index: number,
): Promise<string> {
  const sender = getSender(scenario, message.sender);
  const externalEventId = `eval-message-${index + 1}`;
  const occurredAt = new Date(DEFAULT_BASE_TIME.getTime() + index * 2_000);
  const { data, error } = await client
    .from('conversation_events')
    .insert({
      family_id: familyId,
      source: 'telegram',
      conversation_id: `eval-chat-${scenario.id}`,
      external_event_id: externalEventId,
      actor_external_id: sender.id,
      actor_display_name: sender.displayName,
      actor_username: sender.username,
      event_type: 'message',
      content_original: message.text,
      language_original: 'unknown',
      metadata: { evalScenario: scenario.id },
      source_payload: {},
      occurred_at: occurredAt.toISOString(),
      ingested_at: occurredAt.toISOString(),
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`Failed to insert eval event: ${error?.message}`);
  }

  return String(data.id);
}

function createCannedProvider(
  scenario: PipelineSnapshotScenario,
): MockProvider {
  const provider = new MockProvider({
    defaultResponse: {
      content: '',
      error: new Error(`No canned Scribe response matched ${scenario.id}`),
    },
  });

  for (const message of scenario.messages) {
    const sender = getSender(scenario, message.sender);
    provider.addResponse(currentMessagePattern(sender, message.text), {
      content: JSON.stringify(message.cannedScribe),
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  }

  return provider;
}

function currentMessagePattern(sender: EvalSender, text: string): RegExp {
  return new RegExp(
    `MESSAGE from ${escapeRegExp(sender.displayName)}:\\n${escapeRegExp(
      text,
    )}(?:\\n|$)`,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getSender(
  scenario: PipelineSnapshotScenario,
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

function printReport(results: ScenarioResult[]): void {
  console.log('Pipeline Snapshot Report');
  console.log(`Generated: ${new Date().toISOString()}`);
  console.log('');
  console.log('Scenario                           Result');
  console.log('------------------------------------------');
  for (const result of results) {
    console.log(
      `${result.scenarioId.padEnd(34)} ${result.passed ? 'PASS' : 'FAIL'}`,
    );
    for (const mismatch of result.mismatches) {
      console.log(`  ${mismatch}`);
    }
  }
  console.log('------------------------------------------');
  console.log(
    `Aggregate: ${results.every((result) => result.passed) ? 'PASS' : 'FAIL'}`,
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    printScenarioList();
    return;
  }

  const client = createDbClient(options);
  const scenarios = selectScenarios(
    pipelineSnapshotScenarios,
    options.scenarioIds,
  );
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    console.log(`Running ${scenario.id}...`);
    results.push(await runScenario(client, scenario, options));
  }

  if (options.json) {
    console.log(JSON.stringify({ generatedAt: new Date(), results }, null, 2));
  } else {
    printReport(results);
  }

  if (results.some((result) => !result.passed)) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
