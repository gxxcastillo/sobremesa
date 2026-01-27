/**
 * Anthropic Provider
 *
 * Wraps the Anthropic SDK to implement the AIProvider interface.
 */

import type { AIProvider } from '../provider.interface';
import type {
  AICompletionRequest,
  AICompletionResponse,
  AIMessageContent,
  ProviderConfig,
} from '../types';

/**
 * Anthropic SDK client type.
 * Using unknown to avoid version mismatches - actual client is injected.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnthropicClient = any;

/**
 * Anthropic message content types.
 */
interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

interface AnthropicImageBlock {
  type: 'image';
  source: {
    type: 'base64' | 'url';
    media_type: string;
    data?: string;
    url?: string;
  };
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicImageBlock;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
  model: string;
  stop_reason?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

/**
 * Options for creating an Anthropic provider.
 */
export interface AnthropicProviderOptions {
  /** Pre-initialized Anthropic client */
  client?: AnthropicClient;
  /** Configuration (used if client not provided) */
  config?: ProviderConfig;
}

/**
 * Anthropic provider implementation.
 */
export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic';
  private client: AnthropicClient;
  private defaultModel: string;

  constructor(options: AnthropicProviderOptions) {
    if (options.client) {
      this.client = options.client;
    } else if (options.config?.apiKey) {
      // Dynamically import and create client
      // Note: Caller should handle the import and pass the client
      throw new Error(
        'AnthropicProvider requires a pre-initialized client. ' +
          'Create it with: new Anthropic({ apiKey })',
      );
    } else {
      throw new Error(
        'AnthropicProvider requires either a client or config.apiKey',
      );
    }

    this.defaultModel =
      options.config?.defaultModel || 'claude-sonnet-4-5-20250929';
  }

  /**
   * Create provider from an existing Anthropic client.
   */
  static fromClient(
    client: AnthropicClient,
    defaultModel?: string,
  ): AnthropicProvider {
    return new AnthropicProvider({
      client,
      config: { type: 'anthropic', defaultModel },
    });
  }

  // Models that support native structured outputs (output_format parameter)
  private static STRUCTURED_OUTPUT_MODELS = [
    'claude-sonnet-4-5',
    'claude-opus-4-1',
    'claude-opus-4-5',
    'claude-haiku-4-5',
  ];

  /**
   * Check if a model supports native structured outputs.
   */
  private supportsStructuredOutputs(model: string): boolean {
    return AnthropicProvider.STRUCTURED_OUTPUT_MODELS.some(
      (supported) => model.includes(supported) || model.startsWith(supported),
    );
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    const model = request.model || this.defaultModel;

    // Convert messages to Anthropic format
    const messages = this.convertMessages(request.messages);

    // Check if using JSON schema output format
    const hasJsonSchemaFormat =
      request.responseFormat &&
      typeof request.responseFormat === 'object' &&
      request.responseFormat.type === 'json_schema';

    // Only use native structured outputs if the model supports it
    const useNativeStructuredOutputs =
      hasJsonSchemaFormat && this.supportsStructuredOutputs(model);

    // Log structured output mode for debugging
    if (hasJsonSchemaFormat) {
      console.log(
        `[Anthropic Provider] Model: ${model}, Using native structured outputs: ${useNativeStructuredOutputs}`,
      );
    }

    // Build system prompt, potentially with JSON schema for unsupported models
    let systemPrompt = request.system || '';
    if (
      hasJsonSchemaFormat &&
      !useNativeStructuredOutputs &&
      request.responseFormat &&
      typeof request.responseFormat === 'object'
    ) {
      // Model doesn't support native structured outputs - include schema in prompt
      const schemaJson = JSON.stringify(
        request.responseFormat.json_schema.schema,
        null,
        2,
      );
      console.log(
        `[Anthropic Provider] Embedding schema in system prompt (${schemaJson.length} chars)`,
      );
      systemPrompt = systemPrompt
        ? `${systemPrompt}\n\n## Required JSON Schema\n\nYou MUST respond with valid JSON that conforms exactly to this schema. Use these exact field names:\n\n\`\`\`json\n${schemaJson}\n\`\`\`\n\nRespond ONLY with the JSON object, no additional text.`
        : `Respond with valid JSON conforming to this schema:\n\n\`\`\`json\n${schemaJson}\n\`\`\``;
    }

    // Build request
    const anthropicRequest: Record<string, unknown> = {
      model,
      max_tokens: request.maxTokens,
      messages,
    };

    if (systemPrompt) {
      anthropicRequest['system'] = systemPrompt;
    } else if (request.system) {
      anthropicRequest['system'] = request.system;
    }

    // Add output_format for native structured outputs (supported models only)
    if (
      useNativeStructuredOutputs &&
      request.responseFormat &&
      typeof request.responseFormat === 'object'
    ) {
      anthropicRequest['output_format'] = {
        type: 'json_schema',
        schema: request.responseFormat.json_schema.schema,
      };
    }

    if (request.temperature !== undefined) {
      anthropicRequest['temperature'] = request.temperature;
    }

    if (request.stopSequences && request.stopSequences.length > 0) {
      anthropicRequest['stop_sequences'] = request.stopSequences;
    }

    // Call Anthropic API
    // Use beta endpoint only for native structured outputs on supported models
    let response: AnthropicResponse;
    if (useNativeStructuredOutputs) {
      anthropicRequest['betas'] = ['structured-outputs-2025-11-13'];
      response = await this.client.beta.messages.create(anthropicRequest);
    } else {
      response = await this.client.messages.create(anthropicRequest);
    }

    // Extract text content
    const textContent = response.content.find(
      (c): c is { type: 'text'; text: string } =>
        c.type === 'text' && typeof c.text === 'string',
    );

    if (!textContent) {
      throw new Error('No text content in Anthropic response');
    }

    return {
      content: textContent.text,
      usage: {
        inputTokens: response.usage?.input_tokens || 0,
        outputTokens: response.usage?.output_tokens || 0,
        totalTokens:
          (response.usage?.input_tokens || 0) +
          (response.usage?.output_tokens || 0),
      },
      model: response.model,
      stopReason: this.mapStopReason(response.stop_reason),
    };
  }

  supportsVision(): boolean {
    return true;
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Try a minimal API call to check availability
      await this.client.messages.create({
        model: this.defaultModel,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'test' }],
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Convert our message format to Anthropic format.
   */
  private convertMessages(
    messages: AICompletionRequest['messages'],
  ): AnthropicMessage[] {
    return messages.map((msg) => ({
      role: msg.role,
      content:
        typeof msg.content === 'string'
          ? msg.content
          : this.convertContent(msg.content),
    }));
  }

  /**
   * Convert content blocks to Anthropic format.
   */
  private convertContent(content: AIMessageContent[]): AnthropicContentBlock[] {
    return content.map((block) => {
      if (block.type === 'text') {
        return { type: 'text', text: block.text };
      }

      if (block.type === 'image') {
        return {
          type: 'image',
          source: {
            type: block.source.type,
            media_type: block.source.mediaType || 'image/jpeg',
            ...(block.source.data && { data: block.source.data }),
            ...(block.source.url && { url: block.source.url }),
          },
        };
      }

      // Fallback for unknown types
      return { type: 'text', text: '' };
    });
  }

  /**
   * Map Anthropic stop reasons to our format.
   */
  private mapStopReason(reason?: string): AICompletionResponse['stopReason'] {
    switch (reason) {
      case 'end_turn':
        return 'end_turn';
      case 'max_tokens':
        return 'max_tokens';
      case 'stop_sequence':
        return 'stop_sequence';
      default:
        return reason;
    }
  }
}
