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

The runner requires `ANTHROPIC_API_KEY` or `LOCAL_LLM_BASE_URL`. It exits non-zero if the aggregate
score is below the threshold, which defaults to `0.8`.

These live-LLM evals are manual only. Do not add them to `bun run test:all` or CI.

## Scoring

The scorer uses the same word-boundary token matching exported by `@sobremesa/agents-registrar`.
Each actual extraction can satisfy at most one required expectation, so duplicate extractions count
against precision. Forbidden extractions are hard failures.

The report prints the aggregate score as the initial baseline on the first real run. Keep that
baseline in PR/release notes when extraction behavior changes.

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

Until the Tier-2 runner is wired, use `scripts/simulate-messages.ts <scenario> --dump` as the manual
snapshot source for local investigation. Tier 2 still must not make live LLM calls in CI.

## Product Rubrics

Product example banks currently live in `spec/product/warmth.md` and `spec/product/culture.md`.
They are seed material for future eval scenarios. Those files may need to split later if the
examples become dedicated eval fixtures or grow enough to obscure the product requirements.
