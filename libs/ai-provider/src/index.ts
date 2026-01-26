/**
 * AI Provider Library
 *
 * Provides a unified interface for working with multiple AI providers.
 *
 * @example
 * ```typescript
 * import { loadAIConfig, createAIProviderFactory } from '@sobremesa/ai-provider';
 * import Anthropic from '@anthropic-ai/sdk';
 *
 * // Load configuration from environment
 * const config = loadAIConfig(process.env);
 *
 * // Create factory with Anthropic client
 * const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
 * const factory = createAIProviderFactory(config, anthropic);
 *
 * // Get provider for a specific agent
 * const scribeProvider = factory.getProviderForAgent('scribe');
 * const scribeModel = factory.getModelForAgent('scribe');
 *
 * // Make a completion request
 * const response = await scribeProvider.complete({
 *   model: scribeModel,
 *   maxTokens: 4096,
 *   system: 'You are a helpful assistant.',
 *   messages: [{ role: 'user', content: 'Hello!' }],
 * });
 * ```
 */

// Types
export type {
  AIMessage,
  AIMessageContent,
  AITextContent,
  AIImageContent,
  AICompletionRequest,
  AICompletionResponse,
  ProviderConfig,
  AgentModelConfig,
  AIConfig,
  JsonSchema,
  ResponseFormat,
} from './lib/types';

// Provider interface
export type { AIProvider } from './lib/provider.interface';

// Configuration
export {
  loadAIConfig,
  validateConfig,
  getAgentModelConfig,
  DEFAULT_MODELS,
  AGENT_MODEL_RECOMMENDATIONS,
} from './lib/config';
export type { AgentName } from './lib/config';

// Factory
export { AIProviderFactory, createAIProviderFactory } from './lib/factory';

// Providers
export {
  AnthropicProvider,
  OpenAICompatibleProvider,
  MockProvider,
} from './lib/providers';
export type {
  AnthropicProviderOptions,
  OpenAICompatibleProviderOptions,
  MockProviderOptions,
  MockResponse,
  RecordedRequest,
} from './lib/providers';
