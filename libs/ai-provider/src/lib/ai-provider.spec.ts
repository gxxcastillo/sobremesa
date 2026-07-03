import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadAIConfig, validateConfig } from './config';
import { AIProviderFactory } from './factory';
import { AnthropicProvider } from './providers/anthropic';
import { MockProvider } from './providers/mock';
import type { AIConfig } from './types';

describe('loadAIConfig', () => {
  it('should load config with anthropic when API key provided', () => {
    const env = {
      ANTHROPIC_API_KEY: 'sk-ant-test',
    };

    const config = loadAIConfig(env);

    expect(config.providers['anthropic']).toBeDefined();
    expect(config.providers['anthropic']?.type).toBe('anthropic');
    expect(config.defaultProvider).toBe('anthropic');
  });

  it('should load config with local provider when base URL provided', () => {
    const env = {
      LOCAL_LLM_BASE_URL: 'http://localhost:11434/v1',
      LOCAL_LLM_MODEL: 'llama3.2:latest',
    };

    const config = loadAIConfig(env);

    expect(config.providers['local']).toBeDefined();
    expect(config.providers['local']?.type).toBe('openai-compatible');
    expect(config.providers['local']?.baseUrl).toBe(
      'http://localhost:11434/v1',
    );
    expect(config.defaultProvider).toBe('local');
  });

  it('should fall back to mock when no providers configured', () => {
    const config = loadAIConfig({});

    expect(config.providers['mock']).toBeDefined();
    expect(config.defaultProvider).toBe('mock');
  });

  it('should respect per-agent provider overrides', () => {
    const env = {
      ANTHROPIC_API_KEY: 'sk-ant-test',
      LOCAL_LLM_BASE_URL: 'http://localhost:11434/v1',
      AI_PROVIDER_DEFAULT: 'anthropic',
      AI_PROVIDER_INTERN: 'local',
    };

    const config = loadAIConfig(env);

    expect(config.agentModels.intern?.provider).toBe('local');
    expect(config.agentModels.scribe?.provider).toBe('anthropic');
  });
});

describe('validateConfig', () => {
  it('should warn when only mock provider is available', () => {
    const config = loadAIConfig({});
    const warnings = validateConfig(config);

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('No AI providers configured');
  });

  it('should not warn when anthropic is configured', () => {
    const config = loadAIConfig({ ANTHROPIC_API_KEY: 'sk-ant-test' });
    const warnings = validateConfig(config);

    expect(
      warnings.find((w) => w.includes('No AI providers configured')),
    ).toBeUndefined();
  });
});

describe('AIProviderFactory', () => {
  let config: AIConfig;

  beforeEach(() => {
    config = loadAIConfig({
      LOCAL_LLM_BASE_URL: 'http://localhost:11434/v1',
    });
  });

  it('should create mock provider', () => {
    const factory = new AIProviderFactory(config);
    const provider = factory.getProvider('mock');

    expect(provider).toBeInstanceOf(MockProvider);
    expect(provider.name).toBe('mock');
  });

  it('should register and retrieve custom providers', () => {
    const factory = new AIProviderFactory(config);
    const mockProvider = new MockProvider();

    factory.registerProvider('custom', mockProvider);
    const retrieved = factory.getProvider('custom');

    expect(retrieved).toBe(mockProvider);
  });

  it('should get provider for agent', () => {
    const factory = new AIProviderFactory(config);
    const provider = factory.getProviderForAgent('intern');

    expect(provider).toBeDefined();
  });

  it('should get model for agent', () => {
    const factory = new AIProviderFactory(config);
    const model = factory.getModelForAgent('scribe');

    expect(model).toBeDefined();
    expect(typeof model).toBe('string');
  });
});

describe('MockProvider', () => {
  it('should return configured response', async () => {
    const provider = MockProvider.withResponse('Test response');

    const response = await provider.complete({
      model: 'test-model',
      maxTokens: 100,
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(response.content).toBe('Test response');
  });

  it('should record requests', async () => {
    const provider = new MockProvider();

    await provider.complete({
      model: 'test-model',
      maxTokens: 100,
      system: 'You are helpful',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const requests = provider.getRecordedRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.request.system).toBe('You are helpful');
  });

  it('should match patterns and return specific responses', async () => {
    const provider = new MockProvider();
    provider.addResponse('special keyword', {
      content: 'Special response',
    });

    const response = await provider.complete({
      model: 'test-model',
      maxTokens: 100,
      messages: [
        { role: 'user', content: 'Message with special keyword here' },
      ],
    });

    expect(response.content).toBe('Special response');
  });

  it('should throw configured error', async () => {
    const provider = MockProvider.withError(new Error('API Error'));

    await expect(
      provider.complete({
        model: 'test-model',
        maxTokens: 100,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    ).rejects.toThrow('API Error');
  });

  it('should report vision support', () => {
    const provider = new MockProvider({ supportsVision: true });
    expect(provider.supportsVision()).toBe(true);

    const noVision = new MockProvider({ supportsVision: false });
    expect(noVision.supportsVision()).toBe(false);
  });
});

describe('AnthropicProvider', () => {
  it('uses prompt-embedded schema fallback when json_schema.strict is false', async () => {
    const betaCreate = vi.fn();
    const messagesCreate = vi.fn(async (request: Record<string, unknown>) => ({
      content: [{ type: 'text', text: '{}' }],
      model: String(request['model']),
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const provider = AnthropicProvider.fromClient({
      beta: { messages: { create: betaCreate } },
      messages: { create: messagesCreate },
    });

    await provider.complete({
      model: 'claude-sonnet-4-5-20250929',
      maxTokens: 100,
      system: 'Extract JSON.',
      messages: [{ role: 'user', content: 'hello' }],
      responseFormat: {
        type: 'json_schema',
        json_schema: {
          name: 'test',
          strict: false,
          schema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            additionalProperties: false,
          },
        },
      },
    });

    expect(betaCreate).not.toHaveBeenCalled();
    expect(messagesCreate).toHaveBeenCalledTimes(1);
    const request = messagesCreate.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(request['output_format']).toBeUndefined();
    expect(String(request['system'])).toContain('Required JSON Schema');
  });
});
