# AI Providers & Prompts

Agents call `libs/ai-provider` rather than vendor SDKs directly. Prompts live as text templates in
`libs/prompts`.

## 5.1 Provider Abstraction

The `AIProvider` interface supports text/JSON completions, optional vision, model listing, and
availability checks. Requests include model, messages/system prompt, token/temperature controls,
optional Anthropic prompt caching, and optional JSON/JSON-schema response format. There is no general
tool-use surface.

## 5.2 Providers

| Provider          | Use                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| Anthropic         | Primary production provider; supports prompt caching and native structured output on supported Claude models. |
| OpenAI-compatible | Local/Ollama/LM Studio style providers via configurable base URL.                                             |
| Mock              | Deterministic tests and no-key development fallback.                                                          |

## 5.3 Model Resolution

Agent tiers:

| Tier     | Agents              |
| -------- | ------------------- |
| fast     | Intern, Facilitator |
| standard | Scribe, Historian   |
| vision   | Curator             |

Provider resolution: `AI_PROVIDER_DEFAULT`, then Anthropic if `ANTHROPIC_API_KEY` exists, then local if
`LOCAL_LLM_BASE_URL` exists, then mock. Per-agent overrides use `AI_PROVIDER_{AGENT}`.

The chatbots app does not wire AI routing/extraction/Q&A agents when the resolved default provider is
mock.

## 5.4 Prompts and Structured Output

Prompt templates are filled from family config and runtime values:

- `scribe.txt`: extraction, cultural terms, thoroughness/confidence knobs.
- `intern-filter.txt`, `intern-image-link.txt`: routing/filtering and image references.
- `historian.txt`: Q&A language/persona.
- `facilitator.txt`, `facilitator-response.txt`: warm questions and answer sending.
- `curator.txt`: image analysis.

Admin has no prompt: every response (`/status`, DM help, join/leave, mentions) is a deterministic
formatted template, never an LLM call. An `admin.txt` prompt existed with no caller until it was
deleted (`agent-hygiene-plan.md` #5); see the dead-end register in
`.agents/spec-editorial-state.md`.

Scribe uses JSON-schema constrained structured output. Pipeline version strings and token usage are
recorded for audit/cost tracking.

Scribe requests pin sampling temperature (default `0`, set in `ScribeConfig`) rather than inheriting
the provider default, so identical messages extract identically and eval run-to-run spread measures
the pipeline rather than the sampler. The same pinned value applies in production and in Tier-1
evals — scored sampling behavior is production sampling behavior. Intern's filter call pins
`temperature: 0` the same way, so a message's relevance verdict doesn't vary by re-run.

## 5.5 Evaluation

Extraction quality is evaluated outside normal tests through `libs/evals`.

- **Tier 1: Scribe unit evals.** Manual live-provider runs call the real `ScribeAgent` with
  in-memory repositories and scored scenario goldens. These scenarios check required people, places,
  events, relationships, stories, claims, attribution fields, and forbidden extractions. The runner
  starts with a `0.8` aggregate threshold, prints the first real run's score as the baseline, and can
  report Anthropic and local provider columns side by side with a diagnostic capability gap. Reports
  record the sampling temperature alongside provider and model so recorded baselines are comparable
  across runs.
- **Tier 1: Intern routing/filter evals.** Manual live-provider runs call `InternAgent.route()` once
  per message with in-memory repositories and production-matching character-budgeted context. Exact
  expectations cover route, relevance, and language, including off-topic/news, acknowledgements,
  emoji-only replies, and same-day logistics that must not reach Scribe. Run with `bun nx run
evals:intern`; it is never part of CI or `bun run test:all`.
- **Tier 2: pipeline golden snapshots.** Deterministic local-DB runs use canned Scribe JSON/mock
  provider responses to drive `MessageProcessor` through Registrar persistence and compare stable DB
  snapshots while ignoring IDs and timestamps. The local-DB runner must refuse non-local Supabase
  targets unless explicitly overridden.

Live LLM evals are never part of `bun run test:all` or CI. CI-safe evaluation must use deterministic
fixtures, mock providers, or recorded/canned responses only.

## 5.6 Replacing LLM Calls With Recorded Responses (Dev Only)

`CachingProvider` (`libs/ai-provider`) is a dev-only `AIProvider` decorator: it hashes a request's
model + rendered system/messages + sampling/format params and, on a repeat of that same hash,
substitutes the previously stored `AICompletionResponse` instead of calling the wrapped provider;
on a miss it calls through and stores the result (backed by `SqliteDevResponseCacheStore`, a local
sqlite file). Errors are never stored, so a failed call is retried for real next time. Since the
lookup key is a hash of the fully rendered request, a prompt or model change is simply not found
and calls through for real — no separate invalidation step.

This is explicitly not normal request behavior — it makes output depend on local disk state rather
than the live model — so it is opt-in only and never wired into the live pipeline:
`apps/cli`'s `sbm process --response-replay` (re-processing the same queued fixture at no cost
once prompts/models stop changing) and `apps/eval` (`LLM_RESPONSE_REPLAY=1`, see
`apps/eval/README.md`).

`sbm process --response-replay-batch` seeds the cache in bulk instead of one live call per
message: it builds every currently-queued message's exact Scribe request
(`buildScribeCompletionRequest`, the same construction `ScribeAgent.process()` itself uses, so a
batch-seeded entry can't drift from what a live call would actually send), submits them all as one
Anthropic Message Batch (`submitAnthropicBatchAndWait`, `libs/ai-provider`; half the per-token price,
no per-message round trip), polls until Anthropic finishes, and writes each result into the same
store a live `--response-replay` recording would. `--model=<id>` overrides the Scribe model for a run
(both the batch submission and the run that replays it, since model is part of the cache key).
