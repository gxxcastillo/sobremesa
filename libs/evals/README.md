# Evals

Manual evaluation harnesses for extraction quality. This library is not imported by any deployed app.

## Tier 1: Scribe Unit Evals

Tier 1 runs the real `ScribeAgent` with a live configured provider and in-memory repositories. It
does not use the database. Scenarios live in `src/scenarios/scribe-scenarios.ts`; each scenario has:

- sender profiles
- optional initial context
- current message sequence
- golden expectations for required and forbidden extractions

Run all scenarios:

```bash
bun run evals
```

List scenarios:

```bash
bun nx run evals:run -- --list
```

Run one scenario:

```bash
bun nx run evals:run -- --scenario bot-question-answer
```

Run configured Anthropic and local providers side by side:

```bash
bun nx run evals:run -- --provider anthropic --provider local
```

The runner requires `ANTHROPIC_API_KEY` or `LOCAL_LLM_BASE_URL`. By default it runs every configured
live provider in Anthropic-then-local order and excludes the mock provider. It exits non-zero if any
provider's aggregate score is below the threshold, which defaults to `0.8`.

These live-LLM evals are manual only. Do not add them to `bun run test:all` or CI.

## Scoring

The scorer uses the same word-boundary token matching exported by `@sobremesa/agents-registrar`.
Each actual extraction can satisfy at most one required expectation, so duplicate extractions count
against precision. Forbidden extractions are hard failures.

Before scoring, the scorer applies the pipeline's deterministic evidence-grounding check
(`createGrounder` from `@sobremesa/agents-registrar`) to every claim, exactly as the Registrar
does — including the same bounded context window the model saw (`contextWindow`, default 30):
claims whose `evidence` span matches only a context message are dropped (the pipeline rejects
them as context bleed), and claims whose evidence matches nothing are kept but counted as
unmatched (the pipeline persists them flagged). The report shows per-scenario grounding tallies
when any claim fails, plus an aggregate grounding-failure rate (context-bleed + unmatched over
total claims). A rising unmatched rate means the model is paraphrasing evidence; a rising bleed
rate means context is leaking into extraction.

Because bleed claims are filtered out before scoring, the failure rate itself gates the suite:
a report FAILs when the aggregate grounding-failure rate exceeds `GROUNDING_FAILURE_GATE`
(0.15), regardless of score — otherwise a regression that wholesale re-extracts context would be
invisible to the acceptance baseline.

The report prints one score column per provider. When Anthropic and local run together it also prints
the capability gap (`anthropic - local`) per scenario and in aggregate. Anthropic remains the
acceptance baseline: a pipeline change should hold or improve Anthropic's score and use the local
gap only as a diagnostic for pipeline ambiguity. The local side is most useful with a competent
middle-weight model; a model that scores zero everywhere is not informative.

The first real Anthropic run is the initial baseline. Keep that score in PR/release notes when
extraction behavior changes.

## Adding A Scenario

1. Add a `ScribeEvalScenario` to `src/scenarios/scribe-scenarios.ts`.
2. Keep the current message under test in `messages`.
3. Put setup-only prior messages in `initialContext` so they are available to Scribe but not scored.
4. Add required goldens for the categories under test.
5. Add forbidden goldens for known failure modes, especially bot-as-person and context bleed.

## Tier 2: Pipeline Golden Snapshots

Tier 2 is the deterministic local-DB tier: canned Scribe JSON drives `MessageProcessor` through the
Registrar path, and the resulting DB state is compared to golden snapshots while ignoring IDs and
timestamps. This is intentionally separate from Tier 1 and must use the mock provider or canned
responses only.

Run all Tier-2 scenarios:

```bash
bun run evals:pipeline
```

Run one scenario:

```bash
bun nx run evals:pipeline -- --scenario pipeline-family-history
```

The runner requires Supabase env vars and refuses non-local `SUPABASE_URL` values unless
`--allow-remote-db` is passed. It creates one disposable eval family per scenario and deletes it
after comparison unless `--keep-family` is passed. Tier 2 still must not make live LLM calls in CI.

`scripts/simulate-messages.ts <scenario> --dump` remains useful for manual investigation with a
running chatbot worker. Its scenarios are embedded in the script and depend on live processing, so
the Tier-2 harness keeps its own canned-response fixtures rather than importing that script.

## Product Rubrics

Product example banks currently live in `spec/product/warmth.md` and `spec/product/culture.md`.
They are seed material for future eval scenarios. Those files may need to split later if the
examples become dedicated eval fixtures or grow enough to obscure the product requirements.
