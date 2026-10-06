/**
 * Anthropic Provider
 *
 * Wraps the Anthropic SDK to implement the AIProvider interface.
 */

import { createLogger } from '@sobremesa/shared-utils';
import type { AIProvider } from '../provider.interface';
import type {
  AICompletionRequest,
  AICompletionResponse,
  AIMessageContent,
  ProviderConfig,
  ResponseFormat,
} from '../types';

const logger = createLogger({ name: 'anthropic', level: 'debug' });

/**
 * Narrows `ResponseFormat` to the schema-constrained variant. A real type
 * predicate (rather than a derived boolean) so every call site gets
 * `.json_schema` narrowing from TypeScript, instead of re-checking
 * `typeof responseFormat === 'object' && responseFormat.type === 'json_schema'`
 * by hand at each use.
 */
function isJsonSchemaFormat(
  responseFormat: ResponseFormat | undefined,
): responseFormat is Extract<ResponseFormat, { type: 'json_schema' }> {
  return (
    typeof responseFormat === 'object' && responseFormat.type === 'json_schema'
  );
}

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
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
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
 * Beta header required for native structured outputs (`output_format`).
 * Shared with `anthropic-batch.ts` so the live and batch submission paths
 * can never drift on the flag value.
 */
export const STRUCTURED_OUTPUTS_BETA = 'structured-outputs-2025-11-13';

// Models that support native structured outputs (output_format parameter)
const STRUCTURED_OUTPUT_MODELS = [
  'claude-sonnet-4-5',
  'claude-opus-4-1',
  'claude-opus-4-5',
  'claude-haiku-4-5',
];

function supportsStructuredOutputs(model: string): boolean {
  return STRUCTURED_OUTPUT_MODELS.some(
    (supported) => model.includes(supported) || model.startsWith(supported),
  );
}

/**
 * Convert our message format to Anthropic format.
 */
function convertMessages(
  messages: AICompletionRequest['messages'],
): AnthropicMessage[] {
  return messages.map((msg) => ({
    role: msg.role,
    content:
      typeof msg.content === 'string'
        ? msg.content
        : convertContent(msg.content),
  }));
}

/**
 * Convert content blocks to Anthropic format.
 */
function convertContent(content: AIMessageContent[]): AnthropicContentBlock[] {
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
function mapStopReason(reason?: string): AICompletionResponse['stopReason'] {
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

/**
 * The Anthropic API request body for a completion request, plus whether it
 * needs the beta structured-outputs endpoint/header. Pure and side-effect
 * free (besides a debug log) so it can back both a live `complete()` call
 * and a Batch API submission (`libs/ai-provider`'s dev response cache
 * batch-seeding) from the exact same logic -- the two must never drift, or a
 * batch-seeded cache entry would silently misrepresent what a live call
 * actually sends.
 */
export interface AnthropicRequestBuild {
  /** Body for `client.messages.create` / a batch request's `params`. */
  params: Record<string, unknown>;
  /** True if this must go through `client.beta.messages.create` (or the
   * beta batches endpoint with a matching `betas` entry) for native
   * structured outputs. */
  useBeta: boolean;
}

export function buildAnthropicRequestParams(
  request: AICompletionRequest,
  defaultModel: string,
): AnthropicRequestBuild {
  const model = request.model || defaultModel;
  const responseFormat = request.responseFormat;

  const messages = convertMessages(request.messages);

  const hasJsonSchemaFormat = isJsonSchemaFormat(responseFormat);
  const useNativeStructuredOutputs =
    isJsonSchemaFormat(responseFormat) &&
    supportsStructuredOutputs(model) &&
    responseFormat.json_schema.strict !== false;

  if (hasJsonSchemaFormat) {
    logger.debug(
      { model, useNativeStructuredOutputs },
      'Structured output mode',
    );
  }

  let systemPrompt = request.system || '';
  if (isJsonSchemaFormat(responseFormat) && !useNativeStructuredOutputs) {
    const schemaJson = JSON.stringify(
      responseFormat.json_schema.schema,
      null,
      2,
    );
    logger.debug(
      { schemaLength: schemaJson.length },
      'Embedding schema in system prompt',
    );
    systemPrompt = systemPrompt
      ? `${systemPrompt}\n\n## Required JSON Schema\n\nYou MUST respond with valid JSON that conforms exactly to this schema. Use these exact field names:\n\n\`\`\`json\n${schemaJson}\n\`\`\`\n\nRespond ONLY with the JSON object, no additional text.`
      : `Respond with valid JSON conforming to this schema:\n\n\`\`\`json\n${schemaJson}\n\`\`\``;
  }

  const params: Record<string, unknown> = {
    model,
    max_tokens: request.maxTokens,
    messages,
  };

  const finalSystemPrompt = systemPrompt || request.system;
  if (finalSystemPrompt) {
    if (request.enablePromptCache) {
      params['system'] = [
        {
          type: 'text',
          text: finalSystemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ];
    } else {
      params['system'] = finalSystemPrompt;
    }
  }

  if (useNativeStructuredOutputs && isJsonSchemaFormat(responseFormat)) {
    params['output_format'] = {
      type: 'json_schema',
      schema: responseFormat.json_schema.schema,
    };
  }

  if (request.temperature !== undefined) {
    params['temperature'] = request.temperature;
  }

  if (request.stopSequences && request.stopSequences.length > 0) {
    params['stop_sequences'] = request.stopSequences;
  }

  if (useNativeStructuredOutputs) {
    params['betas'] = [STRUCTURED_OUTPUTS_BETA];
  }

  return { params, useBeta: useNativeStructuredOutputs };
}

/**
 * Map a raw Anthropic message response into our provider-agnostic shape.
 * Shared by the live `complete()` path and batch-result processing.
 */
export function mapAnthropicResponse(
  response: AnthropicResponse,
): AICompletionResponse {
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
      cacheReadTokens: response.usage?.cache_read_input_tokens || 0,
      cacheCreationTokens: response.usage?.cache_creation_input_tokens || 0,
    },
    model: response.model,
    stopReason: mapStopReason(response.stop_reason),
  };
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

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    const { params, useBeta } = buildAnthropicRequestParams(
      request,
      this.defaultModel,
    );

    // Use beta endpoint only for native structured outputs on supported models
    const response: AnthropicResponse = useBeta
      ? await this.client.beta.messages.create(params)
      : await this.client.messages.create(params);

    // Log cache performance if prompt caching was enabled
    if (request.enablePromptCache && response.usage) {
      const cacheRead = response.usage.cache_read_input_tokens || 0;
      const cacheCreation = response.usage.cache_creation_input_tokens || 0;
      if (cacheRead > 0 || cacheCreation > 0) {
        logger.debug({ cacheRead, cacheCreation }, 'Prompt cache stats');
      }
    }

    return mapAnthropicResponse(response);
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
}
