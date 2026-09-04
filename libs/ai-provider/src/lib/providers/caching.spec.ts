import { describe, it, expect, vi } from 'vitest';
import { CachingProvider, hashCompletionRequest } from './caching';
import { MockProvider } from './mock';
import type { DevResponseCacheStore } from './caching';
import type { AICompletionRequest, AICompletionResponse } from '../types';

function inMemoryStore(): DevResponseCacheStore {
  const rows = new Map<string, AICompletionResponse>();
  return {
    get: (key) => rows.get(key),
    set: (key, _request, response) => {
      rows.set(key, response);
    },
  };
}

const baseRequest: AICompletionRequest = {
  model: 'claude-sonnet-5',
  maxTokens: 100,
  system: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: 'Hello!' }],
};

describe('hashCompletionRequest', () => {
  it('produces the same key for requests that only differ in enablePromptCache', () => {
    const a = hashCompletionRequest({
      ...baseRequest,
      enablePromptCache: true,
    });
    const b = hashCompletionRequest({
      ...baseRequest,
      enablePromptCache: false,
    });
    expect(a).toBe(b);
  });

  it('produces different keys when the model differs', () => {
    const a = hashCompletionRequest(baseRequest);
    const b = hashCompletionRequest({
      ...baseRequest,
      model: 'claude-haiku-4-5',
    });
    expect(a).not.toBe(b);
  });

  it('produces different keys when the rendered prompt differs', () => {
    const a = hashCompletionRequest(baseRequest);
    const b = hashCompletionRequest({
      ...baseRequest,
      messages: [{ role: 'user', content: 'Goodbye!' }],
    });
    expect(a).not.toBe(b);
  });
});

describe('CachingProvider', () => {
  it('calls through on a miss and stores the response', async () => {
    const inner = MockProvider.withResponse('real response');
    const spy = vi.spyOn(inner, 'complete');
    const provider = new CachingProvider(inner, inMemoryStore());

    const response = await provider.complete(baseRequest);

    expect(response.content).toBe('real response');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(provider.getStats()).toEqual({ hits: 0, misses: 1 });
  });

  it('replays the stored response on a repeat call instead of calling through', async () => {
    const inner = MockProvider.withResponse('real response');
    const spy = vi.spyOn(inner, 'complete');
    const store = inMemoryStore();
    const provider = new CachingProvider(inner, store);

    await provider.complete(baseRequest);
    const second = await provider.complete({ ...baseRequest });

    expect(second.content).toBe('real response');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(provider.getStats()).toEqual({ hits: 1, misses: 1 });
  });

  it('calls through again for a different model or prompt', async () => {
    const inner = MockProvider.withResponse('real response');
    const spy = vi.spyOn(inner, 'complete');
    const provider = new CachingProvider(inner, inMemoryStore());

    await provider.complete(baseRequest);
    await provider.complete({ ...baseRequest, model: 'claude-haiku-4-5' });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(provider.getStats()).toEqual({ hits: 0, misses: 2 });
  });

  it('does not cache errors', async () => {
    const inner = MockProvider.withError(new Error('boom'));
    const provider = new CachingProvider(inner, inMemoryStore());

    await expect(provider.complete(baseRequest)).rejects.toThrow('boom');
    expect(provider.getStats()).toEqual({ hits: 0, misses: 1 });
  });

  describe("mode: 'record-only'", () => {
    it('calls through every time and never substitutes a stored response', async () => {
      const inner = MockProvider.withResponse('real response');
      const spy = vi.spyOn(inner, 'complete');
      const store = inMemoryStore();
      const provider = new CachingProvider(inner, store, {
        mode: 'record-only',
      });

      await provider.complete(baseRequest);
      const second = await provider.complete({ ...baseRequest });

      expect(second.content).toBe('real response');
      expect(spy).toHaveBeenCalledTimes(2);
      expect(provider.getStats()).toEqual({ hits: 0, misses: 2 });
    });

    it('still saves every response to the store', async () => {
      const inner = MockProvider.withResponse('real response');
      const store = inMemoryStore();
      const provider = new CachingProvider(inner, store, {
        mode: 'record-only',
      });

      await provider.complete(baseRequest);

      const key = hashCompletionRequest(baseRequest);
      expect(store.get(key)?.content).toBe('real response');
    });

    it('produces the same output as an unwrapped provider (recording never changes behavior)', async () => {
      const inner = MockProvider.withResponse('real response');
      const store = inMemoryStore();
      const replay = new CachingProvider(inner, store, { mode: 'replay' });
      const recordOnly = new CachingProvider(inner, inMemoryStore(), {
        mode: 'record-only',
      });

      const [a, b] = await Promise.all([
        replay.complete(baseRequest),
        recordOnly.complete(baseRequest),
      ]);

      expect(a.content).toBe(b.content);
    });
  });
});
