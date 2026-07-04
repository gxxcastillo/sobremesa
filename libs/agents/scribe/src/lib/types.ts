import type { SupportedLanguage } from '@sobremesa/shared-types';

/**
 * Configuration for the Scribe agent.
 */
export interface ScribeConfig {
  /** Maximum tokens for response */
  maxTokens: number;
  /** Extraction thoroughness level */
  thoroughness: 'essential' | 'standard' | 'comprehensive';
  /** Confidence threshold for extraction */
  confidence: 'strict' | 'moderate' | 'lenient';
  /** Cultural terms to preserve (never translate) */
  culturalTerms: string[];
  /** Scribe name for prompts */
  scribeName: string;
  /** Primary language for the family */
  primaryLanguage: SupportedLanguage;
}

/**
 * Default Scribe configuration.
 */
export const DEFAULT_SCRIBE_CONFIG: ScribeConfig = {
  maxTokens: 4096,
  thoroughness: 'standard',
  confidence: 'moderate',
  culturalTerms: [],
  scribeName: 'Scribe',
  primaryLanguage: 'en',
};

/**
 * Image context for Scribe.
 */
export interface ImageContext {
  /** Image ID (short form for referencing) */
  id: string;
  /** File type: photo, document, video */
  fileType: string;
  /** Who shared this image */
  sharedBy?: string;
  /** When it was shared */
  sharedAt: Date;
  /** Whether Curator has analyzed it */
  analyzed: boolean;
  /** Description from Curator analysis */
  description?: string;
  /** Number of people visible */
  peopleCount?: number;
  /** Estimated era/decade */
  estimatedEra?: string;
  /** Visible text extracted */
  visibleText?: string[];
}

/**
 * Context provided to Scribe for processing.
 * Note: People and places are no longer included - Registrar handles entity matching.
 */
export interface ScribeContext {
  /** Recent messages for context */
  recentMessages: Array<{
    content: string;
    senderName: string;
    occurredAt: Date;
  }>;
  /** Message that the current event replied to, when available */
  replyToMessage?: {
    content: string;
    senderName: string;
    occurredAt: Date;
  };
  /** Bot question that the current event answered, when available */
  answeredQuestion?: {
    content: string;
    askedByName: string;
  };
  /** Recent images shared in conversation */
  recentImages: ImageContext[];
}
