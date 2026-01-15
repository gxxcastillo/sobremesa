import { loadPrompt } from '@sobremesa/prompts';
import type { Question, FamilyConfig } from '@sobremesa/shared-types';

/**
 * Default personality values for the Facilitator.
 */
const DEFAULT_PERSONALITY = {
  formality: 'friendly',
  emojiUsage: 'minimal',
  engagement: 'curious',
  verbosity: 'moderate',
  patience: 'moderate',
} as const;

/**
 * Build the system prompt for the Facilitator warmth transformation.
 *
 * @param config - Family configuration containing personality settings
 * @returns The filled system prompt
 */
export function buildSystemPrompt(config: FamilyConfig): string {
  const personality = config.bots?.facilitator?.personality ?? {};
  const facilitatorName =
    config.bots?.facilitator?.displayName ?? 'Facilitator';
  const primaryLanguage = config.languages?.primary ?? 'en';
  const culturalTerms = config.culturalTerms ?? [];

  const values = {
    FACILITATOR_NAME: facilitatorName,
    FORMALITY: personality.formality ?? DEFAULT_PERSONALITY.formality,
    EMOJI_USAGE: personality.emojiUsage ?? DEFAULT_PERSONALITY.emojiUsage,
    ENGAGEMENT: personality.engagement ?? DEFAULT_PERSONALITY.engagement,
    VERBOSITY: personality.verbosity ?? DEFAULT_PERSONALITY.verbosity,
    PATIENCE: personality.patience ?? DEFAULT_PERSONALITY.patience,
    PRIMARY_LANGUAGE: primaryLanguage,
    CULTURAL_TERMS:
      culturalTerms.length > 0 ? culturalTerms.join(', ') : 'none',
  };

  return loadPrompt('facilitator', values);
}

/**
 * Build the user prompt for transforming a question with warmth.
 *
 * @param question - The question to transform
 * @returns The user prompt with question context
 */
export function buildUserPrompt(question: Question): string {
  const parts: string[] = [];

  parts.push('Please apply the warmth formula to this question:');
  parts.push('');
  parts.push(`**Question:** ${question.contentOriginal}`);

  if (question.targetPerson) {
    parts.push(`**Who to ask:** ${question.targetPerson}`);
  }

  if (question.storyContext) {
    parts.push(`**Story context:** ${question.storyContext}`);
  }

  if (question.targetEvent) {
    parts.push(`**Related event:** ${question.targetEvent}`);
  }

  if (question.targetPlace) {
    parts.push(`**Related place:** ${question.targetPlace}`);
  }

  parts.push('');
  parts.push(
    'Remember: Apply all four components (Warmth + Question + Permission + Gratitude). Output ONLY the final message text.',
  );

  return parts.join('\n');
}
