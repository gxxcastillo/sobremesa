# @sobremesa/ai-provider

Unified interface for AI completion providers. Supports Anthropic (Claude) and OpenAI-compatible APIs (Ollama, LM Studio, etc.).

## Usage

```typescript
import { loadAIConfig, createAIProviderFactory } from '@sobremesa/ai-provider';
import Anthropic from '@anthropic-ai/sdk';

// Load configuration from environment
const config = loadAIConfig(process.env);

// Create factory with Anthropic client
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const factory = createAIProviderFactory(config, anthropic);

// Get provider for a specific agent
const provider = factory.getProviderForAgent('scribe');
const model = factory.getModelForAgent('scribe');

// Generate a response
const response = await provider.complete({
  model,
  maxTokens: 4096,
  system: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

## Providers

| Provider                   | Description                                     |
| -------------------------- | ----------------------------------------------- |
| `AnthropicProvider`        | Claude models via Anthropic API                 |
| `OpenAICompatibleProvider` | Ollama, LM Studio, or any OpenAI-compatible API |
| `MockProvider`             | Testing provider with configurable responses    |

## Response Format

For OpenAI-compatible providers, you can request structured JSON output:

```typescript
// Basic JSON mode - forces valid JSON
await provider.complete({
  // ...
  responseFormat: 'json',
});

// Schema mode - forces JSON matching a specific schema
await provider.complete({
  // ...
  responseFormat: {
    type: 'json_schema',
    json_schema: {
      name: 'my_output',
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          count: { type: 'number' },
        },
        required: ['name'],
      },
    },
  },
});
```

## Environment Variables

| Variable              | Description                                                |
| --------------------- | ---------------------------------------------------------- |
| `ANTHROPIC_API_KEY`   | Anthropic API key                                          |
| `LOCAL_LLM_BASE_URL`  | Base URL for local LLM (e.g., `http://localhost:11434/v1`) |
| `LOCAL_LLM_MODEL`     | Default model for local LLM                                |
| `LOCAL_LLM_API_KEY`   | API key for local LLM (if required)                        |
| `AI_PROVIDER_DEFAULT` | Default provider (`anthropic` or `local`)                  |
| `AI_PROVIDER_<AGENT>` | Override provider for specific agent                       |
