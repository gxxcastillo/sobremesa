# Multi-Model Support Plan for Sobremesa

## Overview

This plan outlines how to update Sobremesa to support different AI models/providers, enabling local development with a local LLM running on your um890 to avoid running out of Anthropic tokens.

## Current State

### AI Integration Architecture

- **Provider**: Anthropic SDK only (`@anthropic-ai/sdk`)
- **Models Used**:
  - `claude-sonnet-4-20250514` - Scribe, Historian (complex reasoning)
  - `claude-3-5-haiku-20241022` - Intern, Facilitator, Curator (fast/cheap)
- **Integration Pattern**: Direct SDK injection via constructor options
- **API Key**: `ANTHROPIC_API_KEY` environment variable

### AI Agents Making API Calls

| Agent       | Purpose                   | Current Model | Token Usage           |
| ----------- | ------------------------- | ------------- | --------------------- |
| Intern      | Message filtering/routing | Haiku         | Low (~100 tokens)     |
| Scribe      | Entity extraction         | Sonnet 4      | High (~4096 tokens)   |
| Historian   | Question answering        | Sonnet 4      | Medium (~1024 tokens) |
| Facilitator | Warmth transformation     | Haiku         | Low                   |
| Curator     | Image analysis            | Haiku         | Medium                |

---

## Proposed Architecture

### 1. AI Provider Abstraction Layer

Create a new library `@sobremesa/ai-provider` that abstracts AI provider interactions.

```
libs/
  ai-provider/
    src/
      lib/
        types.ts              # Provider-agnostic types
        provider.interface.ts # Provider contract
        providers/
          anthropic.ts        # Anthropic adapter
          openai-compatible.ts # OpenAI-compatible adapter (Ollama, LM Studio, etc.)
          mock.ts             # Mock provider for testing
        factory.ts            # Provider factory
        config.ts             # Configuration loading
      index.ts
```

### 2. Provider Interface

```typescript
// libs/ai-provider/src/lib/provider.interface.ts

export interface AIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | AIMessageContent[];
}

export interface AIMessageContent {
  type: 'text' | 'image';
  text?: string;
  source?: {
    type: 'base64' | 'url';
    media_type?: string;
    data?: string;
    url?: string;
  };
}

export interface AICompletionRequest {
  model: string;
  messages: AIMessage[];
  system?: string;
  maxTokens: number;
  temperature?: number;
}

export interface AICompletionResponse {
  content: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  model: string;
  stopReason?: string;
}

export interface AIProvider {
  name: string;
  complete(request: AICompletionRequest): Promise<AICompletionResponse>;
  supportsVision(): boolean;
  listModels?(): Promise<string[]>;
}
```

### 3. Provider Configuration

```typescript
// libs/ai-provider/src/lib/config.ts

export interface ProviderConfig {
  type: 'anthropic' | 'openai-compatible' | 'mock';
  apiKey?: string;
  baseUrl?: string; // For local/custom endpoints
  defaultModel?: string;
}

export interface AIConfig {
  providers: Record<string, ProviderConfig>;
  agentModels: {
    intern: { provider: string; model: string };
    scribe: { provider: string; model: string };
    historian: { provider: string; model: string };
    facilitator: { provider: string; model: string };
    curator: { provider: string; model: string };
  };
}
```

### 4. Environment Configuration

```bash
# .env.example additions

# AI Provider Configuration
# -------------------------

# Anthropic (Cloud)
ANTHROPIC_API_KEY=sk-ant-...

# Local LLM (OpenAI-compatible API - Ollama, LM Studio, etc.)
LOCAL_LLM_BASE_URL=http://um890.local:11434/v1
LOCAL_LLM_MODEL=llama3.2:latest

# Provider Selection (per environment)
# Options: anthropic, local, mock
AI_PROVIDER_DEFAULT=anthropic

# Per-agent provider overrides (optional)
# AI_PROVIDER_INTERN=local
# AI_PROVIDER_SCRIBE=anthropic
# AI_PROVIDER_HISTORIAN=anthropic
# AI_PROVIDER_FACILITATOR=local
# AI_PROVIDER_CURATOR=local
```

---

## Implementation Steps

### Phase 1: Create AI Provider Abstraction Library

**Task 1.1: Scaffold the library**

```bash
nx g @nx/node:library ai-provider --directory=libs/ai-provider --buildable
```

**Task 1.2: Define provider interface and types**

- Create `provider.interface.ts` with the `AIProvider` contract
- Create `types.ts` with message and response types
- Ensure compatibility with both Anthropic and OpenAI message formats

**Task 1.3: Implement Anthropic adapter**

- Wrap existing Anthropic SDK usage
- Map internal types to/from Anthropic SDK types
- Handle vision/image content

**Task 1.4: Implement OpenAI-compatible adapter**

- Support OpenAI API format (used by Ollama, LM Studio, LocalAI, etc.)
- Handle base URL configuration for local endpoints
- Map internal types to/from OpenAI format

**Task 1.5: Implement mock provider**

- For testing without API calls
- Configurable responses

**Task 1.6: Create provider factory**

- Load configuration from environment
- Instantiate providers based on config
- Support per-agent provider selection

### Phase 2: Update Agent Configuration

**Task 2.1: Update shared types**

- Add AI provider configuration to `SobremesaConfig`
- Add provider/model selection to agent configs

**Task 2.2: Update agent type definitions**

- `libs/agents/scribe/src/lib/types.ts`
- `libs/agents/historian/src/lib/types.ts`
- `libs/agents/intern/src/lib/intern.ts`
- `libs/agents/facilitator/src/lib/facilitator.ts`
- `libs/agents/curator/src/lib/curator.ts`

### Phase 3: Refactor Agents to Use Abstraction

**Task 3.1: Update InternAgent**

- Replace `AnthropicClient` with `AIProvider`
- Update API call to use provider interface

**Task 3.2: Update ScribeAgent**

- Replace direct Anthropic SDK calls with provider
- Ensure JSON parsing still works with different providers

**Task 3.3: Update HistorianAgent**

- Replace direct Anthropic SDK calls with provider

**Task 3.4: Update FacilitatorAgent**

- Replace direct Anthropic SDK calls with provider

**Task 3.5: Update CuratorAgent**

- Replace direct Anthropic SDK calls with provider
- Handle vision capability check for local models

### Phase 4: Update Application Initialization

**Task 4.1: Update `apps/chatbots/src/main.ts`**

- Replace direct Anthropic client creation with provider factory
- Load AI configuration from environment
- Create providers and inject into agents

**Task 4.2: Update processor**

- Ensure providers are correctly passed through the pipeline

### Phase 5: Local LLM Setup Documentation

**Task 5.1: Create setup guide for um890 but do not add to this repo, call it out as documentation for dev to add to their own notes**

- Ollama installation and configuration
- Recommended models for each agent type
- Network configuration for remote access
- Performance tuning

---

## Recommended Local Models

For your um890 (assuming AMD Ryzen 9 6900HX with decent RAM):

| Agent       | Anthropic Model | Recommended Local Alternative       |
| ----------- | --------------- | ----------------------------------- |
| Intern      | Haiku           | `llama3.2:3b` or `phi3:mini`        |
| Scribe      | Sonnet 4        | `llama3.2:latest` or `mixtral:8x7b` |
| Historian   | Sonnet 4        | `llama3.2:latest` or `mixtral:8x7b` |
| Facilitator | Haiku           | `llama3.2:3b` or `phi3:mini`        |
| Curator     | Haiku           | `llava:13b` (vision support)        |

---

## Configuration Examples

### Development (Local LLM for most, Anthropic for complex tasks)

```bash
AI_PROVIDER_DEFAULT=local
AI_PROVIDER_SCRIBE=anthropic  # Use cloud for complex extraction
AI_PROVIDER_HISTORIAN=anthropic  # Use cloud for quality answers
```

### Production (All Anthropic)

```bash
AI_PROVIDER_DEFAULT=anthropic
```

### Testing (Mock)

```bash
AI_PROVIDER_DEFAULT=mock
```

---

## File Changes Summary

### New Files

- `libs/ai-provider/src/lib/types.ts`
- `libs/ai-provider/src/lib/provider.interface.ts`
- `libs/ai-provider/src/lib/providers/anthropic.ts`
- `libs/ai-provider/src/lib/providers/openai-compatible.ts`
- `libs/ai-provider/src/lib/providers/mock.ts`
- `libs/ai-provider/src/lib/factory.ts`
- `libs/ai-provider/src/lib/config.ts`
- `libs/ai-provider/src/index.ts`
- `docs/local-llm-setup.md`

### Modified Files

- `libs/shared/types/src/lib/config.ts` - Add AI config types
- `libs/agents/scribe/src/lib/scribe.ts` - Use provider abstraction
- `libs/agents/scribe/src/lib/types.ts` - Update config types
- `libs/agents/historian/src/lib/historian.ts` - Use provider abstraction
- `libs/agents/historian/src/lib/types.ts` - Update config types
- `libs/agents/intern/src/lib/intern.ts` - Use provider abstraction
- `libs/agents/facilitator/src/lib/facilitator.ts` - Use provider abstraction
- `libs/agents/curator/src/lib/curator.ts` - Use provider abstraction
- `apps/chatbots/src/main.ts` - Initialize providers via factory
- `.env.example` - Add new environment variables

---

## Risks and Mitigations

### Risk 1: Local model quality differences

- **Mitigation**: Keep Anthropic for critical agents (Scribe, Historian) in development
- **Mitigation**: Add quality validation tests that work across providers

### Risk 2: Different prompt format requirements

- **Mitigation**: Abstract prompt formatting in the provider adapters
- **Mitigation**: Test prompts with both providers

### Risk 3: Vision support inconsistency

- **Mitigation**: Check `supportsVision()` before using Curator with local models
- **Mitigation**: Fall back to Anthropic for Curator if local doesn't support vision

### Risk 4: JSON parsing with local models

- **Mitigation**: Add robust JSON extraction that handles markdown code blocks
- **Mitigation**: Use smaller, well-tested models known for JSON output

---

## Testing Strategy

1. **Unit tests**: Mock provider for all agent tests
2. **Integration tests**: Test each provider adapter independently
3. **E2E tests**: Test with both Anthropic and local providers
4. **Quality comparison**: Run same inputs through both providers and compare outputs

---

## Success Criteria

1. All agents work with both Anthropic and OpenAI-compatible providers
2. Provider can be configured per-agent via environment variables
3. Local development can run entirely on local LLM
4. No changes required to prompts library
5. Graceful fallback when local model unavailable
6. Token usage tracking works across providers
