import { Elysia, t } from 'elysia';
import type { DatabaseClient } from '@sobremesa/database';
import { runScenario, scoreScenario } from '@sobremesa/evals';
import { buildScenario, type RunInput } from '../scenario-builders';
import { resolveProvider, type RunConfig } from '../providers';
import { RecordingProvider } from '../recording-provider';
import { estimateCost } from '../pricing';
import type { EvalStore } from '../store';

const SCORING_THRESHOLD = 0.8;

const contextMessageOverrideSchema = t.Object({
  senderName: t.String(),
  text: t.String(),
  occurredAt: t.Optional(t.String()),
});

const scribeConfigOverrideSchema = t.Object({
  thoroughness: t.Optional(
    t.Union([
      t.Literal('essential'),
      t.Literal('standard'),
      t.Literal('comprehensive'),
    ]),
  ),
  confidence: t.Optional(
    t.Union([t.Literal('strict'), t.Literal('moderate'), t.Literal('lenient')]),
  ),
  scribeName: t.Optional(t.String()),
  primaryLanguage: t.Optional(t.Union([t.Literal('en'), t.Literal('es')])),
});

const runInputSchema = t.Union([
  t.Object({ kind: t.Literal('scenario'), scenarioId: t.String() }),
  t.Object({
    kind: t.Literal('adhoc'),
    text: t.String(),
    senderName: t.Optional(t.String()),
  }),
  t.Object({
    kind: t.Literal('real'),
    familyId: t.String(),
    eventId: t.String(),
    contextWindow: t.Optional(t.Number()),
    contextOverride: t.Optional(t.Array(contextMessageOverrideSchema)),
    scribeConfig: t.Optional(scribeConfigOverrideSchema),
    systemPromptOverride: t.Optional(t.String()),
  }),
]);

const runConfigSchema = t.Object({
  provider: t.Union([
    t.Literal('anthropic'),
    t.Literal('local'),
    t.Literal('lan'),
  ]),
  model: t.String(),
});

/**
 * Runs a scenario once per requested {provider, model} config through the
 * shared Tier-1 harness (`@sobremesa/evals`'s `runScenario`), scoring only
 * the curated-scenario input kind against its golden — ad hoc text and real
 * messages have nothing to score against, so their raw `ScribeDomainModel`
 * output is returned unscored (eval-site-plan.md decision #4).
 */
export function runRoutes(dbClient: DatabaseClient, store: EvalStore) {
  return new Elysia()
    .post(
      '/api/runs',
      async ({ body, set }) => {
        try {
          const input = body.input as RunInput;
          const configs = body.configs as RunConfig[];
          const scenario = await buildScenario(input, dbClient);

          const runOptions =
            input.kind === 'real'
              ? {
                  config: input.scribeConfig,
                  systemPromptOverride: input.systemPromptOverride,
                }
              : undefined;

          const results = [];
          for (const config of configs) {
            // Per-config try/catch: resolveProvider() throws synchronously
            // for a misconfigured config (e.g. a missing API key env var),
            // unlike runScenario itself, which reports failures via
            // `result.error` instead of throwing. Without this, one bad
            // config later in the list would abort the whole request and
            // discard every earlier config's already-completed (and, for a
            // paid provider, already-billed) result along with it.
            try {
              const recordingProvider = new RecordingProvider(
                resolveProvider(config),
              );
              const result = await runScenario(
                scenario,
                recordingProvider,
                config.model,
                runOptions,
              );
              results.push({
                provider: config.provider,
                model: config.model,
                outputs: result.outputs,
                error: result.error?.message,
                score:
                  input.kind === 'scenario'
                    ? scoreScenario(result, SCORING_THRESHOLD)
                    : undefined,
                llmCalls: recordingProvider.calls,
                costEstimate: estimateCost(
                  config.model,
                  recordingProvider.calls,
                ),
              });
            } catch (configErr) {
              results.push({
                provider: config.provider,
                model: config.model,
                outputs: undefined,
                error:
                  configErr instanceof Error
                    ? configErr.message
                    : 'Failed to run this config',
                score: undefined,
                llmCalls: [],
                costEstimate: undefined,
              });
            }
          }

          const stored = store.insertRun({
            id: crypto.randomUUID(),
            input,
            configs,
            results,
          });
          return stored;
        } catch (err) {
          set.status = 500;
          return {
            error: err instanceof Error ? err.message : 'Failed to run',
          };
        }
      },
      {
        body: t.Object({
          input: runInputSchema,
          configs: t.Array(runConfigSchema),
        }),
      },
    )
    .get(
      '/api/runs',
      ({ query }) => {
        const eventIds = query.eventIds
          ? query.eventIds
              .split(',')
              .map((id) => id.trim())
              .filter(Boolean)
          : undefined;
        // Explicit `limit` is always honored and capped; otherwise an
        // `eventIds` lookup is authoritative (no cap — see listRuns), and a
        // plain recency browse (Run History) defaults to 50.
        const limit =
          query.limit !== undefined
            ? Math.min(Math.max(1, query.limit), 200)
            : undefined;
        return store.listRuns({ limit, familyId: query.familyId, eventIds });
      },
      {
        query: t.Object({
          limit: t.Optional(t.Numeric()),
          familyId: t.Optional(t.String()),
          eventIds: t.Optional(t.String()),
        }),
      },
    )
    .get(
      '/api/runs/:id',
      ({ params: { id }, set }) => {
        const run = store.getRun(id);
        if (!run) {
          set.status = 404;
          return { error: 'Run not found' };
        }
        return { ...run, annotations: store.listAnnotations(id) };
      },
      { params: t.Object({ id: t.String() }) },
    )
    .post(
      '/api/runs/:id/annotations',
      ({ params: { id }, body, set }) => {
        const run = store.getRun(id);
        if (!run) {
          set.status = 404;
          return { error: 'Run not found' };
        }
        return store.insertAnnotation({
          id: crypto.randomUUID(),
          runId: id,
          target: body.target,
          verdict: body.verdict,
          note: body.note,
        });
      },
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({
          target: t.Unknown(),
          verdict: t.Union([t.Literal('good'), t.Literal('bad')]),
          note: t.Optional(t.String()),
        }),
      },
    );
}
