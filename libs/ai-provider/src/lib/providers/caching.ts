/**
 * Dev response cache
 *
 * Lets a repeated LLM call replay a stored response instead of hitting the
 * real API, so iterating on the pipeline locally doesn't re-spend on
 * requests that already ran with the same model and prompt. Dev-only -- see
 * `CachingProvider` below.
 */
import { createHash } from 'node:crypto';
import type { AIProvider } from '../provider.interface';
import type { AICompletionRequest, AICompletionResponse } from '../types';

/**
 * Storage for cached completions, keyed by `hashCompletionRequest`.
 * Implementations decide persistence (e.g. sqlite); this interface is just
 * the read/write surface `CachingProvider` needs.
 */
export interface DevResponseCacheStore {
  get(key: string): AICompletionResponse | undefined;
  set(
    key: string,
    request: AICompletionRequest,
    response: AICompletionResponse,
  ): void;
}

/**
 * Cache key for "the same call": everything in the request that can change
 * the model's output -- model, rendered system/messages, and sampling/format
 * params. `enablePromptCache` is deliberately excluded: it only controls
 * Anthropic-side input-token cost, never the response content, so two
 * requests that differ only in that flag are still the same call.
 */
export function hashCompletionRequest(request: AICompletionRequest): string {
  const canonical = {
    model: request.model,
    system: request.system ?? null,
    messages: request.messages,
    maxTokens: request.maxTokens,
    temperature: request.temperature ?? null,
    stopSequences: request.stopSequences ?? null,
    responseFormat: request.responseFormat ?? null,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export interface CachingProviderOptions {
  /**
   * 'replay' (default): check the store first; a hit substitutes the stored
   * response instead of calling through. 'record-only': never substitutes --
   * always calls the wrapped provider -- but still saves every response, so
   * a run's output is identical to not wrapping it at all. Safe to leave
   * always-on, unlike 'replay', which trades a live call for local disk
   * state and so stays an explicit opt-in.
   */
  mode?: 'replay' | 'record-only';
}

/**
 * Dev-only decorator: wraps any `AIProvider` and, in 'replay' mode, replays
 * a stored response for a request it has seen before (same model + rendered
 * prompt + params) instead of calling through. On a miss (or in
 * 'record-only' mode, always), calls the wrapped provider and stores the
 * result. Errors are never cached, so a failed call is retried next time
 * rather than replayed forever.
 *
 * 'replay' mode is not for production use -- only wrap a provider with it in
 * a local dev script or dev-only server, behind an explicit opt-in flag,
 * since it makes a call's output depend on local disk state rather than the
 * live model. 'record-only' mode never changes a call's output, so it has
 * no such restriction.
 */
export class CachingProvider implements AIProvider {
  readonly name: string;
  private readonly mode: 'replay' | 'record-only';
  private hits = 0;
  private misses = 0;
  /**
   * In-flight requests keyed by cache key, so concurrent calls for the same
   * request single-flight onto one call to `inner` instead of each missing
   * the cache and paying for their own live call. Only meaningful in
   * 'replay' mode -- 'record-only' never substitutes a pending call's result.
   */
  private readonly inFlight = new Map<string, Promise<AICompletionResponse>>();

  constructor(
    private readonly inner: AIProvider,
    private readonly store: DevResponseCacheStore,
    options: CachingProviderOptions = {},
  ) {
    this.name = inner.name;
    this.mode = options.mode ?? 'replay';
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    const key = hashCompletionRequest(request);

    if (this.mode === 'replay') {
      const cached = this.store.get(key);
      if (cached) {
        this.hits++;
        return cached;
      }

      const pending = this.inFlight.get(key);
      if (pending) {
        this.hits++;
        return pending;
      }
    }

    this.misses++;
    const promise = this.inner
      .complete(request)
      .then((response) => {
        this.store.set(key, request, response);
        return response;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    if (this.mode === 'replay') {
      this.inFlight.set(key, promise);
    }
    return promise;
  }

  supportsVision(): boolean {
    return this.inner.supportsVision();
  }

  async isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }

  /** Hit/miss counts for this instance's lifetime, e.g. for a run summary. */
  getStats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }
}
