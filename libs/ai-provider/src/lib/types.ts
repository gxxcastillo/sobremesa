/**
 * AI Provider Types
 *
 * Provider-agnostic types for AI completion requests and responses.
 * These types are compatible with both Anthropic and OpenAI-compatible APIs.
 */

/**
 * JSON schema for structured output.
 * Used with json_schema response format for schema-constrained JSON.
 */
export interface JsonSchema {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

/**
 * Response format options.
 * - 'text': Plain text response (default)
 * - 'json': Basic JSON mode (forces valid JSON)
 * - { type: 'json_schema', json_schema: JsonSchema }: Schema-constrained JSON
 */
export type ResponseFormat =
  | 'text'
  | 'json'
  | { type: 'json_schema'; json_schema: JsonSchema };

/**
 * Text content in a message.
 */
export interface AITextContent {
  type: 'text';
  text: string;
}

/**
 * Image content in a message (for vision models).
 */
export interface AIImageContent {
  type: 'image';
  source: {
    type: 'base64' | 'url';
    mediaType?: string; // e.g., 'image/jpeg', 'image/png'
    data?: string; // base64 encoded image data
    url?: string; // URL to image (for url type)
  };
}

/**
 * Content in a message can be text, image, or a mix.
 */
export type AIMessageContent = AITextContent | AIImageContent;

/**
 * A message in a conversation.
 */
export interface AIMessage {
  role: 'user' | 'assistant';
  content: string | AIMessageContent[];
}

/**
 * Request to complete a conversation.
 */
export interface AICompletionRequest {
  /** Model identifier (provider-specific) */
  model: string;
  /** Conversation messages */
  messages: AIMessage[];
  /** System prompt (instructions for the model) */
  system?: string;
  /** Maximum tokens to generate */
  maxTokens: number;
  /** Temperature for sampling (0-1, lower = more deterministic) */
  temperature?: number;
  /** Stop sequences to end generation */
  stopSequences?: string[];
  /** Response format - 'json' or json_schema for structured output */
  responseFormat?: ResponseFormat;
}

/**
 * Response from a completion request.
 */
export interface AICompletionResponse {
  /** Generated text content */
  content: string;
  /** Token usage statistics */
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  /** Model that generated the response */
  model: string;
  /** Reason generation stopped */
  stopReason?: 'end_turn' | 'max_tokens' | 'stop_sequence' | string;
}

/**
 * Configuration for a provider instance.
 */
export interface ProviderConfig {
  /** Provider type */
  type: 'anthropic' | 'openai-compatible' | 'mock';
  /** API key for authentication (optional for local providers) */
  apiKey?: string;
  /** Base URL for API requests (for local/custom endpoints) */
  baseUrl?: string;
  /** Default model to use if not specified in request */
  defaultModel?: string;
  /** Request timeout in milliseconds */
  timeout?: number;
}

/**
 * Per-agent model configuration.
 */
export interface AgentModelConfig {
  /** Provider name (key in providers config) */
  provider: string;
  /** Model to use for this agent */
  model: string;
}

/**
 * Complete AI configuration for the application.
 */
export interface AIConfig {
  /** Available providers */
  providers: Record<string, ProviderConfig>;
  /** Model configuration per agent */
  agentModels: {
    intern?: AgentModelConfig;
    scribe?: AgentModelConfig;
    historian?: AgentModelConfig;
    facilitator?: AgentModelConfig;
    curator?: AgentModelConfig;
  };
  /** Default provider for agents not explicitly configured */
  defaultProvider: string;
}
