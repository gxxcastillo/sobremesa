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
import { DEFAULT_SCRIBE_CONFIG } from '@sobremesa/agents-scribe';
import { buildReport, buildSuiteReport } from '../lib/scorer';
import {
  selectScenarios,
  type EvalReport,
  type EvalSuiteReport,
  type ScenarioRunResult,
} from '../lib/scenario';
import { runScenario } from '../lib/run-scenario';
import { scribeEvalScenarios } from '../scenarios/scribe-scenarios';

const DEFAULT_THRESHOLD = 0.8;

interface CliOptions {
  threshold: number;
  scenarioIds: string[];
  providerNames: string[];
  list: boolean;
  json: boolean;
  dump: boolean;
}

interface ProviderSetup {
  id: string;
  provider: AIProvider;
  model: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    threshold: DEFAULT_THRESHOLD,
    scenarioIds: [],
    providerNames: [],
    list: false,
    json: false,
    dump: false,
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
      case '--dump':
        options.dump = true;
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
  --json              Print the report as JSON.
  --dump              Print each scenario's raw extracted domain models (diagnosis aid).`);
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
  console.log(`Model:     ${report.model} (temperature ${report.temperature})`);
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
    const { grounding } = scenario;
    if (grounding.contextBleed > 0 || grounding.unmatched > 0) {
      console.log(
        `  grounding: ${grounding.grounded}/${grounding.totalClaims} grounded, ${grounding.contextBleed} context-bleed rejected, ${grounding.unmatched} unmatched (kept, flagged)`,
      );
    }
  }
  console.log(
    '----------------------------------------------------------------',
  );
  console.log(
    `Aggregate ${formatScore(report.aggregateScore)} precision ${formatScore(
      report.aggregatePrecision,
    )} recall ${formatScore(report.aggregateRecall)} grounding-failure ${formatScore(
      report.groundingFailureRate,
    )}: ${report.passed ? 'PASS' : 'FAIL'}`,
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
  console.log(
    `Temperature: ${report.reports[0]?.temperature ?? DEFAULT_SCRIBE_CONFIG.temperature}`,
  );
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

  const scenarios = selectScenarios(scribeEvalScenarios, options.scenarioIds);
  const providers = createProviders(options);
  const reports: EvalReport[] = [];

  for (const providerSetup of providers) {
    const results: ScenarioRunResult[] = [];
    for (const scenario of scenarios) {
      console.log(`Running ${providerSetup.id}/${scenario.id}...`);
      const result = await runScenario(
        scenario,
        providerSetup.provider,
        providerSetup.model,
      );
      results.push(result);
      if (options.dump) {
        console.log(
          JSON.stringify(
            {
              scenarioId: scenario.id,
              provider: providerSetup.id,
              outputs: result.outputs,
              error: result.error?.message,
            },
            null,
            2,
          ),
        );
      }
    }

    reports.push(
      buildReport({
        results,
        provider: providerSetup.id,
        model: providerSetup.model,
        temperature: DEFAULT_SCRIBE_CONFIG.temperature,
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
