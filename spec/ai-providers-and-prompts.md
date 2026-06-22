# AI Providers & Prompts

The LLM layer is fully abstracted in `libs/ai-provider`, so agents depend on an interface rather than a
vendor SDK. Prompts live as plain-text templates in `libs/prompts`.

## 5.1 The provider interface

`libs/ai-provider/src/lib/provider.interface.ts`:

```ts
interface AIProvider {
  readonly name: string;
  complete(request: AICompletionRequest): Promise<AICompletionResponse>;
  supportsVision(): boolean;
  listModels?(): Promise<string[]>;
  isAvailable(): Promise<boolean>;
}
```

`AICompletionRequest` carries `model`, `messages`, optional `system`, `maxTokens`, `temperature`,
`stopSequences`, `enablePromptCache` (Anthropic), and `responseFormat`
(`'text' | 'json' | { type:'json_schema', json_schema }`). `AICompletionResponse` returns `content`,
`usage`, `model`, `stopReason`. Completion is **text/JSON only** — there is no general tool-use surface
in the interface.

## 5.2 Implementations (`providers/`)

| Provider                                       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Anthropic** (`anthropic.ts`)                 | Primary. Default models: fast `claude-3-5-haiku-20241022`, standard `claude-sonnet-4-5-20250929`. Uses the beta endpoint `client.beta.messages.create({ betas:['structured-outputs-2025-11-13'] })` for **native structured outputs** (JSON-schema) on supported models (`claude-sonnet-4-5`, `claude-opus-4-1`, `claude-opus-4-5`, `claude-haiku-4-5`). Prompt caching via `cache_control:{type:'ephemeral'}` when `enablePromptCache` is set. |
| **OpenAI-compatible** (`openai-compatible.ts`) | For local models (Ollama, LM Studio, …) at a configurable base URL. JSON via `response_format:{type:'json_object'}`; optional vision flag; plain `fetch` + Bearer auth; models discovered via `/models`.                                                                                                                                                                                                                                        |
| **Mock** (`mock.ts`)                           | Deterministic test provider: canned responses, pattern matching, configurable delay/error simulation. Used when no real provider is configured.                                                                                                                                                                                                                                                                                                 |

## 5.3 Configuration & the factory

`config.ts` builds an `AIConfig` from environment, assigning each agent a tier:

| Agent       | Tier     |
| ----------- | -------- |
| intern      | fast     |
| scribe      | standard |
| historian   | standard |
| facilitator | fast     |
| curator     | vision   |

Resolution order for the default provider: `AI_PROVIDER_DEFAULT` → `anthropic` (if `ANTHROPIC_API_KEY`)
→ `local` (if `LOCAL_LLM_BASE_URL`) → `mock`. Any agent can be overridden with
`AI_PROVIDER_{AGENT}`.

`AIProviderFactory` (`factory.ts`) caches provider instances and resolves per-agent provider/model:
`getProviderForAgent(agent)`, `getModelForAgent(agent)`, `registerProvider(name, provider)` (used to
inject a pre-built Anthropic client). `createAIProviderFactory(config, anthropicClient)` is the
convenience constructor the chatbots app calls at startup.

This design means the system degrades gracefully: with no LLM keys it runs against the mock provider
(or simply ingests without the AI agents, per `apps/chatbots/src/main.ts`).

## 5.4 Prompts (`libs/prompts`)

Prompts are raw `.txt` files imported as text (via a Bun/Vite `?raw`/`.txt` loader) and filled at
runtime. `loadPrompt(name, values)` / `fillPromptTemplate(template, values)` replace
`{PLACEHOLDER}` tokens with values drawn from family config.

| File                       | Agent / use                 | Notable placeholders                                                                                                                        |
| -------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `scribe.txt`               | Scribe extraction           | `{SCRIBE_NAME}`, `{CULTURAL_TERMS}`, `{THOROUGHNESS}`, `{CONFIDENCE}`                                                                       |
| `intern-filter.txt`        | Intern filter/route         | —                                                                                                                                           |
| `intern-image-link.txt`    | Intern image linking        | —                                                                                                                                           |
| `historian.txt`            | Historian Q&A               | `{HISTORIAN_NAME}`, `{PRIMARY_LANGUAGE}`                                                                                                    |
| `facilitator.txt`          | Facilitator question warmth | `{FACILITATOR_NAME}`, `{PRIMARY_LANGUAGE}`, `{CULTURAL_TERMS}`, `{FORMALITY}`, `{VERBOSITY}`, `{EMOJI_USAGE}`, `{ENGAGEMENT}`, `{PATIENCE}` |
| `facilitator-response.txt` | Facilitator answer warmth   | dynamic: question language, answer, original question                                                                                       |
| `admin.txt`                | Admin responses             | `{ADMIN_NAME}`, `{FORMALITY}`, `{VERBOSITY}`, `{EMOJI_USAGE}`, `{AUTHORITY}`, `{CELEBRATION}`, `{MEDIATION}`, `{MAX_SILENCE}`               |
| `curator.txt`              | Curator image analysis      | —                                                                                                                                           |

## 5.5 Structured output & token discipline

- **Structured output:** the Scribe constrains its output to the `ScribeDomainModel` JSON schema
  (schemas are generated from Zod via `zod-to-json-schema`), so the Registrar receives validated data.
- **Prompt caching:** the (large, stable) Scribe system prompt is marked cacheable to cut repeat cost.
- **Pipeline versioning:** each extraction records an `extractionVersion` string composed across the
  agents it passed through (e.g. `intern-v1.0+scribe-v2.1`), giving an audit trail and enabling
  reprocessing with newer agent versions.
- **Token usage** is returned on each agent result (`tokensUsed`) for cost tracking.
