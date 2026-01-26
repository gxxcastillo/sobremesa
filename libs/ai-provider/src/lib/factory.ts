/**
 * AI Provider Factory
 *
 * Creates and manages AI providers based on configuration.
 */

import type { AIProvider } from './provider.interface';
import type { AIConfig, ProviderConfig } from './types';
import type { AgentName } from './config';
import { AnthropicProvider } from './providers/anthropic';
import { OpenAICompatibleProvider } from './providers/openai-compatible';
import { MockProvider } from './providers/mock';

/**
 * Factory for creating AI providers.
 */
export class AIProviderFactory {
  private config: AIConfig;
  private providers: Map<string, AIProvider> = new Map();

  constructor(config: AIConfig) {
    this.config = config;
  }

  /**
   * Get or create a provider by name.
   */
  getProvider(name: string): AIProvider {
    // Return cached provider if available
    const cached = this.providers.get(name);
    if (cached) {
      return cached;
    }

    // Get provider config
    const providerConfig = this.config.providers[name];
    if (!providerConfig) {
      throw new Error(`Unknown provider: ${name}`);
    }

    // Create provider
    const provider = this.createProvider(providerConfig, name);
    this.providers.set(name, provider);

    return provider;
  }

  /**
   * Get the provider configured for a specific agent.
   */
  getProviderForAgent(agent: AgentName): AIProvider {
    const agentConfig = this.config.agentModels[agent];
    if (!agentConfig) {
      // Fall back to default provider
      return this.getProvider(this.config.defaultProvider);
    }

    return this.getProvider(agentConfig.provider);
  }

  /**
   * Get the model configured for a specific agent.
   */
  getModelForAgent(agent: AgentName): string {
    const agentConfig = this.config.agentModels[agent];
    if (agentConfig) {
      return agentConfig.model;
    }

    // Fall back to provider's default model
    const providerConfig = this.config.providers[this.config.defaultProvider];
    return providerConfig?.defaultModel || 'unknown';
  }

  /**
   * Get the default provider.
   */
  getDefaultProvider(): AIProvider {
    return this.getProvider(this.config.defaultProvider);
  }

  /**
   * Check if a provider is available.
   */
  async isProviderAvailable(name: string): Promise<boolean> {
    try {
      const provider = this.getProvider(name);
      return await provider.isAvailable();
    } catch {
      return false;
    }
  }

  /**
   * List all configured providers.
   */
  listProviders(): string[] {
    return Object.keys(this.config.providers);
  }

  /**
   * Get the underlying configuration.
   */
  getConfig(): AIConfig {
    return this.config;
  }

  /**
   * Create a provider from configuration.
   */
  private createProvider(config: ProviderConfig, name: string): AIProvider {
    switch (config.type) {
      case 'anthropic':
        // Note: Anthropic provider requires a pre-initialized client
        // This will be handled by the caller who has access to the SDK
        throw new Error(
          `Anthropic provider "${name}" must be registered manually. ` +
            'Use factory.registerProvider() with a pre-initialized client.',
        );

      case 'openai-compatible':
        return OpenAICompatibleProvider.fromConfig(config);

      case 'mock':
        return new MockProvider();

      default:
        throw new Error(`Unknown provider type: ${config.type}`);
    }
  }

  /**
   * Register a pre-created provider.
   * Use this for providers that require external SDKs (like Anthropic).
   */
  registerProvider(name: string, provider: AIProvider): void {
    this.providers.set(name, provider);
  }

  /**
   * Clear all cached providers.
   */
  clearProviders(): void {
    this.providers.clear();
  }
}

/**
 * Create a factory with Anthropic client already registered.
 * This is a convenience function for the common use case.
 */
export function createAIProviderFactory(
  config: AIConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  anthropicClient?: any,
): AIProviderFactory {
  const factory = new AIProviderFactory(config);

  // Register Anthropic provider if client is provided
  const anthropicConfig = config.providers['anthropic'];
  if (anthropicClient && anthropicConfig) {
    const anthropicProvider = AnthropicProvider.fromClient(
      anthropicClient,
      anthropicConfig.defaultModel,
    );
    factory.registerProvider('anthropic', anthropicProvider);
  }

  return factory;
}
