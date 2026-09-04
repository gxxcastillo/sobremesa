import { Elysia } from 'elysia';
import { OpenAICompatibleProvider } from '@sobremesa/ai-provider';
import { localBaseUrl, lanBaseUrl } from '../providers';

export interface OllamaSourceStatus {
  baseUrl: string | null;
  models: string[];
}

export interface ProvidersInfo {
  anthropic: { configured: boolean };
  local: OllamaSourceStatus;
  lan: OllamaSourceStatus;
}

/**
 * Lets `NewRun` prepopulate the model field for the `local`/`lan`
 * providers with whatever Ollama actually reports right now, instead of
 * free-typing a model id and finding out it's wrong when the run fails.
 * `models: []` covers both "unreachable" and "reachable but nothing pulled"
 * — `OpenAICompatibleProvider.listModels()` doesn't distinguish them, and
 * the UI treatment (fall back to free text, show a hint) is the same either
 * way.
 */
async function probeOllama(baseUrl: string): Promise<OllamaSourceStatus> {
  const models = await OpenAICompatibleProvider.forOllama(baseUrl).listModels();
  return { baseUrl, models };
}

export function providerRoutes() {
  return new Elysia().get('/api/providers', async () => {
    const lanUrl = lanBaseUrl();
    const [local, lan] = await Promise.all([
      probeOllama(localBaseUrl()),
      lanUrl
        ? probeOllama(lanUrl)
        : Promise.resolve<OllamaSourceStatus>({ baseUrl: null, models: [] }),
    ]);

    const info: ProvidersInfo = {
      anthropic: { configured: Boolean(process.env['ANTHROPIC_API_KEY']) },
      local,
      lan,
    };
    return info;
  });
}
