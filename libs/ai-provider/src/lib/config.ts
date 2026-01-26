/**
 * AI Configuration Loader
 *
 * Loads AI provider configuration from environment variables.
 */

import type { AIConfig, ProviderConfig, AgentModelConfig } from './types';

/**
 * Agent names that can be configured.
 */
export type AgentName =
  | 'intern'
  | 'scribe'
  | 'historian'
  | 'facilitator'
  | 'curator';

export type AgentTier = 'fast' | 'standard' | 'vision';

/**
 * Default models for each provider type.
 */
export const DEFAULT_MODELS = {
  anthropic: {
    fast: 'claude-3-5-haiku-20241022',
    standard: 'claude-sonnet-4-5-20250929',
  },
  local: {
    fast: 'llama3.2:3b',
    standard: 'llama3.2:latest',
    vision: 'llava:13b',
  },
} as const;

/**
 * Default model recommendations per agent.
 */
export const AGENT_MODEL_RECOMMENDATIONS: Record<
  AgentName,
  { tier: AgentTier }
> = {
  /**
   * Simple classification (route to admin/scribe/ignore)
   */
  intern: { tier: 'fast' },

  /**
   * Complex structured extraction (entities, claims, relationships)
   */
  scribe: { tier: 'standard' },

  /**
   * Reasoning over stored knowledge to answer questions
   */
  historian: { tier: 'standard' },

  /**
   * Light text transformation (warmth, language matching)
   */
  facilitator: { tier: 'fast' },

  /**
   * Image understanding for photo descriptions
   */
  curator: { tier: 'vision' },
};

/**
 * Environment variable names.
 */
const ENV_KEYS = {
  // Provider selection
  AI_PROVIDER_DEFAULT: 'AI_PROVIDER_DEFAULT',

  // Per-agent provider override
  AI_PROVIDER_INTERN: 'AI_PROVIDER_INTERN',
  AI_PROVIDER_SCRIBE: 'AI_PROVIDER_SCRIBE',
  AI_PROVIDER_HISTORIAN: 'AI_PROVIDER_HISTORIAN',
  AI_PROVIDER_FACILITATOR: 'AI_PROVIDER_FACILITATOR',
  AI_PROVIDER_CURATOR: 'AI_PROVIDER_CURATOR',

  // Anthropic config
  ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY',

  // Local LLM config
  LOCAL_LLM_BASE_URL: 'LOCAL_LLM_BASE_URL',
  LOCAL_LLM_MODEL: 'LOCAL_LLM_MODEL',
  LOCAL_LLM_API_KEY: 'LOCAL_LLM_API_KEY',
} as const;

/**
 * Load AI configuration from environment variables.
 */
export function loadAIConfig(
  env: Record<string, string | undefined>,
): AIConfig {
  const providers: Record<string, ProviderConfig> = {};

  // Configure Anthropic provider if API key is available
  const anthropicKey = env[ENV_KEYS.ANTHROPIC_API_KEY];
  if (anthropicKey) {
    providers['anthropic'] = {
      type: 'anthropic',
      apiKey: anthropicKey,
      defaultModel: DEFAULT_MODELS.anthropic.standard,
    };
  }

  // Configure local provider if base URL is available
  const localBaseUrl = env[ENV_KEYS.LOCAL_LLM_BASE_URL];
  if (localBaseUrl) {
    providers['local'] = {
      type: 'openai-compatible',
      baseUrl: localBaseUrl,
      apiKey: env[ENV_KEYS.LOCAL_LLM_API_KEY],
      defaultModel:
        env[ENV_KEYS.LOCAL_LLM_MODEL] || DEFAULT_MODELS.local.standard,
    };
  }

  // Always add mock provider
  providers['mock'] = {
    type: 'mock',
  };

  // Determine default provider
  let defaultProvider = env[ENV_KEYS.AI_PROVIDER_DEFAULT] || 'anthropic';

  // Fall back to mock if the default provider isn't configured
  if (!providers[defaultProvider]) {
    if (providers['anthropic']) {
      defaultProvider = 'anthropic';
    } else if (providers['local']) {
      defaultProvider = 'local';
    } else {
      defaultProvider = 'mock';
    }
  }

  // Build agent model configuration
  const agentModels = buildAgentModels(env, providers, defaultProvider);

  return {
    providers,
    agentModels,
    defaultProvider,
  };
}

/**
 * Build per-agent model configuration.
 */
function buildAgentModels(
  env: Record<string, string | undefined>,
  providers: Record<string, ProviderConfig>,
  defaultProvider: string,
): AIConfig['agentModels'] {
  const agents: AgentName[] = [
    'intern',
    'scribe',
    'historian',
    'facilitator',
    'curator',
  ];

  const result: AIConfig['agentModels'] = {};

  for (const agent of agents) {
    const envKey =
      `AI_PROVIDER_${agent.toUpperCase()}` as keyof typeof ENV_KEYS;
    const providerName = env[ENV_KEYS[envKey]] || defaultProvider;
    const provider = providers[providerName];

    if (!provider) {
      // Skip if provider not available
      continue;
    }

    const recommendation = AGENT_MODEL_RECOMMENDATIONS[agent];
    const model = getModelForTier(provider, recommendation.tier);

    result[agent] = {
      provider: providerName,
      model,
    };
  }

  return result;
}

/**
 * Get the appropriate model for a tier from a provider config.
 */
function getModelForTier(provider: ProviderConfig, tier: AgentTier): string {
  // If provider has a default model, use it
  if (provider.defaultModel) {
    return provider.defaultModel;
  }

  // Otherwise use defaults based on provider type
  if (provider.type === 'anthropic') {
    switch (tier) {
      case 'fast':
        return DEFAULT_MODELS.anthropic.fast;
      case 'standard':
      case 'vision':
        return DEFAULT_MODELS.anthropic.standard;
    }
  }

  if (provider.type === 'openai-compatible') {
    switch (tier) {
      case 'fast':
        return DEFAULT_MODELS.local.fast;
      case 'standard':
        return DEFAULT_MODELS.local.standard;
      case 'vision':
        return DEFAULT_MODELS.local.vision;
    }
  }

  return 'mock-model';
}

/**
 * Get the model config for a specific agent.
 */
export function getAgentModelConfig(
  config: AIConfig,
  agent: AgentName,
): AgentModelConfig | undefined {
  return config.agentModels[agent];
}

/**
 * Validate that required providers are available.
 */
export function validateConfig(config: AIConfig): string[] {
  const warnings: string[] = [];

  if (Object.keys(config.providers).length === 1 && config.providers['mock']) {
    warnings.push(
      'No AI providers configured. Set ANTHROPIC_API_KEY or LOCAL_LLM_BASE_URL.',
    );
  }

  const missingAgents: AgentName[] = [];
  const agents: AgentName[] = [
    'intern',
    'scribe',
    'historian',
    'facilitator',
    'curator',
  ];

  for (const agent of agents) {
    if (!config.agentModels[agent]) {
      missingAgents.push(agent);
    }
  }

  if (missingAgents.length > 0) {
    warnings.push(
      `No model configured for agents: ${missingAgents.join(', ')}`,
    );
  }

  return warnings;
}
