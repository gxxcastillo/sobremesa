/**
 * AI Provider Interface
 *
 * Contract that all AI providers must implement.
 */

import type { AICompletionRequest, AICompletionResponse } from './types';

/**
 * AI Provider interface.
 * Implementations wrap specific AI APIs (Anthropic, OpenAI, etc.)
 */
export interface AIProvider {
  /** Provider name (e.g., 'anthropic', 'ollama') */
  readonly name: string;

  /**
   * Complete a conversation.
   * @param request The completion request
   * @returns The completion response
   */
  complete(request: AICompletionRequest): Promise<AICompletionResponse>;

  /**
   * Check if this provider supports vision (image) inputs.
   */
  supportsVision(): boolean;

  /**
   * List available models (if supported by the provider).
   * Returns undefined if not supported.
   */
  listModels?(): Promise<string[]>;

  /**
   * Check if the provider is available (has valid credentials, is reachable).
   */
  isAvailable(): Promise<boolean>;
}
