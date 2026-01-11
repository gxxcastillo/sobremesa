import { LanguageConfig } from './languages.js';

/**
 * Bot personality configuration.
 */
export interface BotPersonality {
  formality: 'formal' | 'informal' | 'mixed';
  verbosity: 'concise' | 'moderate' | 'elaborate';
  emojiUsage: 'none' | 'minimal' | 'moderate' | 'frequent';
  warmthLevel: 'professional' | 'warm' | 'very_warm';
}

/**
 * Configuration for a visible bot.
 */
export interface BotConfig {
  displayName: string;
  personality: BotPersonality;
}

/**
 * Configuration for the coaching module.
 */
export interface CoachingConfig {
  enabled: boolean;
  evaluationIntervalHours: number;
  maxRuleChangesPerDay: number;
  minHoursBetweenReversals: number;
}

/**
 * Web3 integration configuration.
 */
export interface Web3Config {
  enabled: boolean;
  chain?: 'solana' | 'ethereum' | 'polygon';
  rpcUrl?: string;
  walletAddress?: string;
}

/**
 * Complete Sobremesa configuration.
 */
export interface SobremesaConfig {
  // Identity
  projectName: string;
  familyId: string;

  // Languages
  languages: LanguageConfig;

  // Bot configurations
  bots: {
    facilitator: BotConfig;
    admin: BotConfig;
    scribe: BotConfig;
  };

  // Cultural adaptation
  culturalTerms: string[];

  // Coaching
  coaching: CoachingConfig;

  // Web3
  web3: Web3Config;
}

/**
 * Default Sobremesa configuration for a Nicaraguan family.
 */
export const DEFAULT_CONFIG: Omit<SobremesaConfig, 'familyId'> = {
  projectName: 'Sobremesa',
  languages: {
    primary: 'es',
    secondary: ['en'],
  },
  bots: {
    facilitator: {
      displayName: 'Carmencita',
      personality: {
        formality: 'informal',
        verbosity: 'moderate',
        emojiUsage: 'minimal',
        warmthLevel: 'very_warm',
      },
    },
    admin: {
      displayName: 'La Directora',
      personality: {
        formality: 'mixed',
        verbosity: 'moderate',
        emojiUsage: 'moderate',
        warmthLevel: 'warm',
      },
    },
    scribe: {
      displayName: 'Don Rubén',
      personality: {
        formality: 'formal',
        verbosity: 'concise',
        emojiUsage: 'none',
        warmthLevel: 'professional',
      },
    },
  },
  culturalTerms: [
    'pulpería',
    'gallo pinto',
    'vigorón',
    'nacatamal',
    'fritanga',
    'pinolillo',
  ],
  coaching: {
    enabled: true,
    evaluationIntervalHours: 24,
    maxRuleChangesPerDay: 1,
    minHoursBetweenReversals: 48,
  },
  web3: {
    enabled: false,
  },
};
