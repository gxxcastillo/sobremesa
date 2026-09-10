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
import { scoreInternRun, type InternScore } from '../lib/intern-scorer';
import {
  runInternScenario,
  type InternScenarioRunResult,
} from '../lib/run-intern-scenario';
import { selectScenarios, type ScribeEvalScenario } from '../lib/scenario';
import { scribeEvalScenarios } from '../scenarios/scribe-scenarios';

interface CliOptions {
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

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    scenarioIds: [],
    providerNames: [],
    list: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--scenario') options.scenarioIds.push(argv[++index]);
    else if (arg === '--provider') options.providerNames.push(argv[++index]);
    else if (arg === '--list') options.list = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printUsage(): void {
  console.log(
    `Usage: bun nx run evals:intern [-- --scenario <id>] [--provider <anthropic|local>] [--list] [--json]`,
  );
}

function getInternModel(config: AIConfig, providerName: string): string {
  const agentModel = config.agentModels.intern;
  if (agentModel?.provider === providerName) return agentModel.model;
  const provider = config.providers[providerName];
  if (provider?.defaultModel) return provider.defaultModel;
  if (provider?.type === 'anthropic') return DEFAULT_MODELS.anthropic.fast;
  if (provider?.type === 'openai-compatible') return DEFAULT_MODELS.local.fast;
  return 'unknown';
}

function createProviders(options: CliOptions): ProviderSetup[] {
  const config = loadAIConfig(process.env);
  const client = process.env['ANTHROPIC_API_KEY']
    ? new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] })
    : undefined;
  const factory = createAIProviderFactory(config, client);
  const names =
    options.providerNames.length > 0
      ? options.providerNames
      : ['anthropic', 'local'].filter((name) => config.providers[name]);
  if (names.length === 0)
    throw new Error(
      'Tier-1 Intern evals require a live provider. Set ANTHROPIC_API_KEY or LOCAL_LLM_BASE_URL.',
    );
  return names.map((id) => {
    if (id === 'mock' || !config.providers[id])
      throw new Error(
        `Provider is not configured for Tier-1 Intern evals: ${id}`,
      );
    return {
      id,
      provider: factory.getProvider(id),
      model: getInternModel(config, id),
    };
  });
}

function printList(scenarios: ScribeEvalScenario[]): void {
  console.log('Available Intern eval scenarios:\n');
  for (const scenario of scenarios)
    console.log(`  ${scenario.id}\n    ${scenario.description}`);
}

function aggregate(scores: InternScore[]): InternScore {
  const total = scores.reduce((sum, score) => sum + score.total, 0);
  const matched = scores.reduce((sum, score) => sum + score.matched, 0);
  return {
    total,
    matched,
    accuracy: total === 0 ? 0 : matched / total,
    mismatches: scores.flatMap((score) => score.mismatches),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const scenarios = selectScenarios(scribeEvalScenarios, options.scenarioIds);
  if (options.list) return printList(scenarios);
  const reports: Array<{
    provider: string;
    model: string;
    results: InternScenarioRunResult[];
    score: InternScore;
  }> = [];
  for (const setup of createProviders(options)) {
    const results: InternScenarioRunResult[] = [];
    const scores: InternScore[] = [];
    for (const scenario of scenarios) {
      console.log(`Running ${setup.id}/${scenario.id}...`);
      const result = await runInternScenario(
        scenario,
        setup.provider,
        setup.model,
      );
      results.push(result);
      scores.push(scoreInternRun(result, scenario));
    }
    reports.push({
      provider: setup.id,
      model: setup.model,
      results,
      score: aggregate(scores),
    });
  }
  if (options.json) console.log(JSON.stringify(reports, null, 2));
  else
    for (const report of reports) {
      console.log(
        `\nIntern Evaluation Report (${report.provider}/${report.model})`,
      );
      console.log(
        `Accuracy: ${(report.score.accuracy * 100).toFixed(1)}% (${report.score.matched}/${report.score.total})`,
      );
      for (const mismatch of report.score.mismatches)
        console.log(
          `  message ${mismatch.messageIndex + 1}: ${mismatch.field} expected ${String(mismatch.expected)}, got ${String(mismatch.actual)}`,
        );
      for (const result of report.results.filter((item) => item.error))
        console.log(`  ${result.scenario.id}: ${result.error?.message}`);
    }
  if (
    reports.some(
      (report) =>
        report.score.matched !== report.score.total ||
        report.results.some((result) => result.error),
    )
  )
    process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
