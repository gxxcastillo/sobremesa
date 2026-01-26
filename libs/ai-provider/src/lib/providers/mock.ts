/**
 * Mock Provider
 *
 * A mock AI provider for testing without making actual API calls.
 * Supports configurable responses and request recording.
 */

import type { AIProvider } from '../provider.interface';
import type { AICompletionRequest, AICompletionResponse } from '../types';

/**
 * Mock response configuration.
 */
export interface MockResponse {
  /** Content to return */
  content: string;
  /** Simulated token usage */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  /** Stop reason */
  stopReason?: AICompletionResponse['stopReason'];
  /** Delay before responding (ms) */
  delay?: number;
  /** Error to throw instead of returning response */
  error?: Error;
}

/**
 * Recorded request for testing assertions.
 */
export interface RecordedRequest {
  request: AICompletionRequest;
  timestamp: Date;
}

/**
 * Options for creating a mock provider.
 */
export interface MockProviderOptions {
  /** Default response when no specific response is configured */
  defaultResponse?: MockResponse;
  /** Map of prompt patterns to responses */
  responses?: Map<string | RegExp, MockResponse>;
  /** Whether vision is "supported" */
  supportsVision?: boolean;
  /** Available models to list */
  models?: string[];
  /** Whether the provider is "available" */
  available?: boolean;
}

/**
 * Mock provider for testing.
 */
export class MockProvider implements AIProvider {
  readonly name = 'mock';

  private defaultResponse: MockResponse;
  private responses: Map<string | RegExp, MockResponse>;
  private visionSupport: boolean;
  private models: string[];
  private available: boolean;
  private recordedRequests: RecordedRequest[] = [];

  constructor(options: MockProviderOptions = {}) {
    this.defaultResponse = options.defaultResponse || {
      content: 'Mock response',
      usage: { inputTokens: 10, outputTokens: 20 },
      stopReason: 'end_turn',
    };
    this.responses = options.responses || new Map();
    this.visionSupport = options.supportsVision ?? true;
    this.models = options.models || ['mock-model'];
    this.available = options.available ?? true;
  }

  /**
   * Create a mock that always returns the same response.
   */
  static withResponse(content: string): MockProvider {
    return new MockProvider({
      defaultResponse: {
        content,
        usage: { inputTokens: 10, outputTokens: content.length / 4 },
        stopReason: 'end_turn',
      },
    });
  }

  /**
   * Create a mock that always throws an error.
   */
  static withError(error: Error): MockProvider {
    return new MockProvider({
      defaultResponse: { content: '', error },
    });
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    // Record the request
    this.recordedRequests.push({
      request,
      timestamp: new Date(),
    });

    // Find matching response
    const response = this.findResponse(request);

    // Apply delay if configured
    if (response.delay && response.delay > 0) {
      await this.delay(response.delay);
    }

    // Throw error if configured
    if (response.error) {
      throw response.error;
    }

    // Return response
    const inputTokens = response.usage?.inputTokens || 10;
    const outputTokens =
      response.usage?.outputTokens || Math.ceil(response.content.length / 4);

    return {
      content: response.content,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
      model: request.model || 'mock-model',
      stopReason: response.stopReason || 'end_turn',
    };
  }

  supportsVision(): boolean {
    return this.visionSupport;
  }

  async listModels(): Promise<string[]> {
    return this.models;
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  /**
   * Get all recorded requests.
   */
  getRecordedRequests(): RecordedRequest[] {
    return [...this.recordedRequests];
  }

  /**
   * Get the last recorded request.
   */
  getLastRequest(): RecordedRequest | undefined {
    return this.recordedRequests[this.recordedRequests.length - 1];
  }

  /**
   * Clear recorded requests.
   */
  clearRecordedRequests(): void {
    this.recordedRequests = [];
  }

  /**
   * Add a response for a specific pattern.
   */
  addResponse(pattern: string | RegExp, response: MockResponse): void {
    this.responses.set(pattern, response);
  }

  /**
   * Set the default response.
   */
  setDefaultResponse(response: MockResponse): void {
    this.defaultResponse = response;
  }

  /**
   * Set availability status.
   */
  setAvailable(available: boolean): void {
    this.available = available;
  }

  /**
   * Find the matching response for a request.
   */
  private findResponse(request: AICompletionRequest): MockResponse {
    // Build a string to match against
    const searchText = this.buildSearchText(request);

    // Check each pattern
    for (const [pattern, response] of this.responses) {
      if (typeof pattern === 'string') {
        if (searchText.includes(pattern)) {
          return response;
        }
      } else if (pattern.test(searchText)) {
        return response;
      }
    }

    return this.defaultResponse;
  }

  /**
   * Build a string from the request for pattern matching.
   */
  private buildSearchText(request: AICompletionRequest): string {
    const parts: string[] = [];

    if (request.system) {
      parts.push(request.system);
    }

    for (const msg of request.messages) {
      if (typeof msg.content === 'string') {
        parts.push(msg.content);
      } else {
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push(block.text);
          }
        }
      }
    }

    return parts.join('\n');
  }

  /**
   * Delay for a number of milliseconds.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
