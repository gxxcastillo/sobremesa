import { Elysia, t } from 'elysia';
import type { DatabaseClient } from '@sobremesa/database';
import {
  buildScenarioPrompt,
  getSender,
  type EvalMessage,
  type ScribeConfig,
} from '@sobremesa/evals';
import {
  buildScenario,
  DEFAULT_REAL_CONTEXT_WINDOW,
} from '../scenario-builders';

type ScribeConfigOverride = Partial<
  Pick<
    ScribeConfig,
    'thoroughness' | 'confidence' | 'scribeName' | 'primaryLanguage'
  >
>;

/**
 * Shows exactly what a `kind: 'real'` run would send to Scribe — the
 * "new run" prompt/context preview (eval-tool-v2-plan.md decision #4,
 * revised) — without spending an LLM call. Built from the same
 * `buildScenario`/`buildScenarioPrompt` path `POST /api/runs` uses for a
 * real run, so preview and actual run can never drift apart.
 */
export function previewRoutes(dbClient: DatabaseClient) {
  return new Elysia().get(
    '/api/families/:id/events/:eventId/preview',
    async ({ params: { id: familyId, eventId }, query, set }) => {
      try {
        const contextWindow =
          query.contextWindow ?? DEFAULT_REAL_CONTEXT_WINDOW;
        const scenario = await buildScenario(
          { kind: 'real', familyId, eventId, contextWindow },
          dbClient,
        );

        const configOverride: ScribeConfigOverride = {
          ...(query.thoroughness && { thoroughness: query.thoroughness }),
          ...(query.confidence && { confidence: query.confidence }),
          ...(query.scribeName && { scribeName: query.scribeName }),
          ...(query.primaryLanguage && {
            primaryLanguage: query.primaryLanguage,
          }),
        };

        const built = await buildScenarioPrompt(scenario, configOverride);

        const toDisplay = (message: EvalMessage) => ({
          senderName: getSender(scenario, message.sender).displayName,
          text: message.text,
          occurredAt: (message.occurredAt ?? new Date()).toISOString(),
        });

        return {
          message: toDisplay(scenario.messages[0]),
          context: (scenario.initialContext ?? []).map(toDisplay),
          contextWindow,
          systemPrompt: built.empty ? '' : built.systemPrompt,
          userMessage: built.empty ? '' : built.userMessage,
          scribeConfig: built.empty ? null : built.config,
          empty: built.empty,
        };
      } catch (err) {
        set.status = 500;
        return {
          error: err instanceof Error ? err.message : 'Failed to build preview',
        };
      }
    },
    {
      params: t.Object({ id: t.String(), eventId: t.String() }),
      query: t.Object({
        contextWindow: t.Optional(t.Numeric()),
        thoroughness: t.Optional(
          t.Union([
            t.Literal('essential'),
            t.Literal('standard'),
            t.Literal('comprehensive'),
          ]),
        ),
        confidence: t.Optional(
          t.Union([
            t.Literal('strict'),
            t.Literal('moderate'),
            t.Literal('lenient'),
          ]),
        ),
        scribeName: t.Optional(t.String()),
        primaryLanguage: t.Optional(
          t.Union([t.Literal('en'), t.Literal('es')]),
        ),
      }),
    },
  );
}
