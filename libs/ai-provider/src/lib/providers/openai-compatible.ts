/**
 * OpenAI-Compatible Provider
 *
 * Works with Ollama, LM Studio, LocalAI, and other OpenAI-compatible APIs.
 * Uses fetch directly to avoid SDK dependencies.
 */

import type { AIProvider } from '../provider.interface';
import type {
  AICompletionRequest,
  AICompletionResponse,
  AIMessageContent,
  ProviderConfig,
} from '../types';

/**
 * OpenAI-compatible message format.
 */
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | OpenAIContentPart[];
}

interface OpenAITextContent {
  type: 'text';
  text: string;
}

interface OpenAIImageContent {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'low' | 'high' | 'auto';
  };
}

type OpenAIContentPart = OpenAITextContent | OpenAIImageContent;

/**
 * OpenAI-compatible response format.
 */
interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Model list response.
 */
interface ModelsResponse {
  object: string;
  data: Array<{
    id: string;
    object: string;
    owned_by: string;
  }>;
}

/**
 * Options for creating an OpenAI-compatible provider.
 */
export interface OpenAICompatibleProviderOptions {
  /** Base URL for the API (e.g., http://localhost:11434/v1 for Ollama) */
  baseUrl: string;
  /** API key (optional for local providers) */
  apiKey?: string;
  /** Default model to use */
  defaultModel?: string;
  /** Provider name for identification */
  name?: string;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Whether this provider supports vision */
  visionSupport?: boolean;
}

/**
 * OpenAI-compatible provider implementation.
 */
export class OpenAICompatibleProvider implements AIProvider {
  readonly name: string;
  private baseUrl: string;
  private apiKey?: string;
  private defaultModel: string;
  private timeout: number;
  private visionSupport: boolean;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.name = options.name || 'openai-compatible';
    this.baseUrl = options.baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.apiKey = options.apiKey;
    this.defaultModel = options.defaultModel || 'llama3.2:latest';
    this.timeout = options.timeout || 120000; // 2 minutes default
    this.visionSupport = options.visionSupport ?? false;
  }

  /**
   * Create a provider for Ollama.
   */
  static forOllama(
    baseUrl = 'http://localhost:11434/v1',
    defaultModel = 'llama3.2:latest',
  ): OpenAICompatibleProvider {
    return new OpenAICompatibleProvider({
      baseUrl,
      defaultModel,
      name: 'ollama',
      visionSupport: false, // Set to true if using llava
    });
  }

  /**
   * Create a provider for LM Studio.
   */
  static forLMStudio(
    baseUrl = 'http://localhost:1234/v1',
    defaultModel = 'local-model',
  ): OpenAICompatibleProvider {
    return new OpenAICompatibleProvider({
      baseUrl,
      defaultModel,
      name: 'lm-studio',
      visionSupport: false,
    });
  }

  /**
   * Create from configuration.
   */
  static fromConfig(config: ProviderConfig): OpenAICompatibleProvider {
    if (!config.baseUrl) {
      throw new Error('OpenAI-compatible provider requires baseUrl');
    }

    return new OpenAICompatibleProvider({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      defaultModel: config.defaultModel,
      timeout: config.timeout,
    });
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    const model = request.model || this.defaultModel;

    // Build messages with system prompt
    const messages = this.buildMessages(request);

    // Build request body
    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.maxTokens,
    };

    if (request.temperature !== undefined) {
      body['temperature'] = request.temperature;
    }

    if (request.stopSequences && request.stopSequences.length > 0) {
      body['stop'] = request.stopSequences;
    }

    // Apply response format if specified
    if (request.responseFormat) {
      if (request.responseFormat === 'json') {
        body['response_format'] = { type: 'json_object' };
      } else if (typeof request.responseFormat === 'object') {
        body['response_format'] = request.responseFormat;
      }
    }

    // Make request
    const response = await this.fetch<OpenAIResponse>(
      '/chat/completions',
      'POST',
      body,
    );

    // Extract content
    const choice = response.choices[0];
    if (!choice || !choice.message.content) {
      throw new Error('No content in OpenAI-compatible response');
    }

    return {
      content: choice.message.content,
      usage: {
        inputTokens: response.usage?.prompt_tokens || 0,
        outputTokens: response.usage?.completion_tokens || 0,
        totalTokens: response.usage?.total_tokens || 0,
      },
      model: response.model,
      stopReason: this.mapFinishReason(choice.finish_reason),
    };
  }

  supportsVision(): boolean {
    return this.visionSupport;
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await this.fetch<ModelsResponse>('/models', 'GET');
      return response.data.map((m) => m.id);
    } catch {
      return [];
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.listModels();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Build messages array including system prompt.
   */
  private buildMessages(request: AICompletionRequest): OpenAIMessage[] {
    const messages: OpenAIMessage[] = [];

    // Add system message if provided
    if (request.system) {
      messages.push({
        role: 'system',
        content: request.system,
      });
    }

    // Add conversation messages
    for (const msg of request.messages) {
      messages.push({
        role: msg.role,
        content:
          typeof msg.content === 'string'
            ? msg.content
            : this.convertContent(msg.content),
      });
    }

    return messages;
  }

  /**
   * Convert content blocks to OpenAI format.
   */
  private convertContent(content: AIMessageContent[]): OpenAIContentPart[] {
    return content.map((block) => {
      if (block.type === 'text') {
        return { type: 'text', text: block.text };
      }

      if (block.type === 'image') {
        // OpenAI uses image_url format
        let url: string;

        if (block.source.type === 'url' && block.source.url) {
          url = block.source.url;
        } else if (block.source.type === 'base64' && block.source.data) {
          const mediaType = block.source.mediaType || 'image/jpeg';
          url = `data:${mediaType};base64,${block.source.data}`;
        } else {
          throw new Error('Invalid image source');
        }

        return {
          type: 'image_url',
          image_url: { url },
        };
      }

      // Fallback
      return { type: 'text', text: '' };
    });
  }

  /**
   * Map finish reason to our format.
   */
  private mapFinishReason(reason: string): AICompletionResponse['stopReason'] {
    switch (reason) {
      case 'stop':
        return 'end_turn';
      case 'length':
        return 'max_tokens';
      case 'stop_sequence':
        return 'stop_sequence';
      default:
        return reason;
    }
  }

  /**
   * Make a fetch request to the API.
   */
  private async fetch<T>(
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `API request failed: ${response.status} ${response.statusText} - ${errorText}`,
        );
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
