import Anthropic from '@anthropic-ai/sdk';
import {
  AnthropicProvider,
  OpenAICompatibleProvider,
  CachingProvider,
  SqliteDevResponseCacheStore,
  type AIProvider,
} from '@sobremesa/ai-provider';

/**
 * One {provider, model} pair the UI asked to run a scenario through.
 * Arbitrary model strings per run (eval-site-plan.md decision #3) — no
 * env-driven tier resolution, so e.g. two different Anthropic model
 * versions can be compared in the same run.
 *
 * 'local' and 'lan' are both Ollama via `OpenAICompatibleProvider` — 'local'
 * targets the machine this server runs on (`LOCAL_LLM_BASE_URL`, default
 * `http://localhost:11434/v1`), 'lan' targets a separate Ollama host on the
 * LAN (`LOCAL_LAN_LLM_BASE_URL`, no default — there's no sensible guess for
 * another machine's address).
 */
export interface RunConfig {
  provider: 'anthropic' | 'local' | 'lan';
  model: string;
}

export function localBaseUrl(): string {
  return process.env['LOCAL_LLM_BASE_URL'] ?? 'http://localhost:11434/v1';
}

export function lanBaseUrl(): string | undefined {
  return process.env['LOCAL_LAN_LLM_BASE_URL'];
}

const anthropicClient = process.env['ANTHROPIC_API_KEY']
  ? new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] })
  : undefined;

/**
 * Replace-with-recorded-response mode (see README.md § Replacing LLM calls
 * with recorded responses): when LLM_RESPONSE_REPLAY is set, every resolved
 * provider substitutes a stored response for a request identical to one
 * already made (same model + rendered prompt) instead of calling the real
 * API — not "normal" behavior, an explicit opt-in that makes a run's output
 * depend on local disk state rather than the live model. One store shared
 * across requests for this process's life, same lazy-singleton shape as
 * `EvalStore`.
 */
const responseReplayDbPath = /^(1|true)$/i.test(
  process.env['LLM_RESPONSE_REPLAY'] ?? '',
)
  ? (process.env['LLM_RESPONSE_REPLAY_DB'] ??
    `${import.meta.dir}/../../tmp/llm-response-replay.db`)
  : undefined;

const responseReplayStore = responseReplayDbPath
  ? new SqliteDevResponseCacheStore(responseReplayDbPath)
  : undefined;

/** For a startup log line — so it's obvious from the console whether a run's output can come from disk instead of the live model. */
export const responseReplayStatus = responseReplayDbPath
  ? ({ enabled: true, dbPath: responseReplayDbPath } as const)
  : ({ enabled: false } as const);

function resolveBaseProvider(config: RunConfig): AIProvider {
  if (config.provider === 'anthropic') {
    if (!anthropicClient) {
      throw new Error(
        'ANTHROPIC_API_KEY is not set — cannot run an anthropic config.',
      );
    }
    return AnthropicProvider.fromClient(anthropicClient);
  }

  if (config.provider === 'local') {
    return OpenAICompatibleProvider.forOllama(localBaseUrl(), config.model);
  }

  if (config.provider === 'lan') {
    const baseUrl = lanBaseUrl();
    if (!baseUrl) {
      throw new Error(
        'LOCAL_LAN_LLM_BASE_URL is not set — cannot run a lan config.',
      );
    }
    return OpenAICompatibleProvider.forOllama(baseUrl, config.model);
  }

  throw new Error(`Unknown provider: ${config.provider}`);
}

export function resolveProvider(config: RunConfig): AIProvider {
  const provider = resolveBaseProvider(config);
  return responseReplayStore
    ? new CachingProvider(provider, responseReplayStore)
    : provider;
}
