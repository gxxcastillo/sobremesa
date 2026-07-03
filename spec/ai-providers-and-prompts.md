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
- `admin.txt`: command/DM/member-event responses.
- `curator.txt`: image analysis.

Scribe uses JSON-schema constrained structured output. Pipeline version strings and token usage are
recorded for audit/cost tracking.

## 5.5 Evaluation

Extraction quality is evaluated outside normal tests through `libs/evals`.

- **Tier 1: Scribe unit evals.** Manual live-provider runs call the real `ScribeAgent` with
  in-memory repositories and scored scenario goldens. These scenarios check required people, places,
  events, relationships, stories, claims, attribution fields, and forbidden extractions. The runner
  starts with a `0.8` aggregate threshold and prints the first real run's score as the baseline.
- **Tier 2: pipeline golden snapshots.** Deterministic local-DB runs use canned Scribe JSON/mock
  provider responses to drive `MessageProcessor` through Registrar persistence and compare stable DB
  snapshots while ignoring IDs and timestamps.

Live LLM evals are never part of `bun run test:all` or CI. CI-safe evaluation must use deterministic
fixtures, mock providers, or recorded/canned responses only.
