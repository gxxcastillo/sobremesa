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
  CachingProvider,
  hashCompletionRequest,
  BudgetedProvider,
  BudgetExhaustedError,
} from './lib/providers';

// Daily spend budget (spend ceiling) and the pricing it uses
export { SpendBudget } from './lib/spend-budget';
export type { SpendBudgetOptions } from './lib/spend-budget';
export { estimateCostUsd, MODEL_PRICING } from './lib/pricing';
export type { UnknownModelPricing } from './lib/pricing';
export type {
  AnthropicProviderOptions,
  OpenAICompatibleProviderOptions,
  MockProviderOptions,
  MockResponse,
  RecordedRequest,
  DevResponseCacheStore,
} from './lib/providers';

// Dev response cache storage (see CachingProvider)
export { SqliteDevResponseCacheStore } from './lib/dev-response-cache-store';

// Anthropic Batch API support for seeding the dev response cache
export { submitAnthropicBatchAndWait } from './lib/anthropic-batch';
export type {
  BatchSeedItem,
  BatchSeedResult,
  BatchRequestCounts,
  SubmitAnthropicBatchOptions,
} from './lib/anthropic-batch';
export type { AnthropicRequestBuild } from './lib/providers/anthropic';
export {
  buildAnthropicRequestParams,
  mapAnthropicResponse,
} from './lib/providers/anthropic';
