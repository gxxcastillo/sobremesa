import { loadPrompt } from '@sobremesa/prompts';
import type {
  Question,
  FamilyConfig,
  LanguageCode,
} from '@sobremesa/shared-types';

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
 * @param isTargetParticipant - Whether the target person is a verified conversation participant.
 *   - true: Person is verified to be in the chat (address them directly)
 *   - false: Person is NOT in the chat (mentioned in story only)
 *   - undefined: Unknown / verification failed (default to group addressing)
 * @returns The user prompt with question context
 */
export function buildUserPrompt(
  question: Question,
  isTargetParticipant?: boolean,
): string {
  const parts: string[] = [];

  parts.push('Please apply the warmth formula to this question:');
  parts.push('');
  parts.push(`**Question:** ${question.contentOriginal}`);

  if (question.targetPerson) {
    if (isTargetParticipant === true) {
      // ONLY include "Who to ask" if VERIFIED participant
      parts.push(`**Who to ask:** ${question.targetPerson}`);
    } else {
      // Either false or undefined - don't address directly
      parts.push(
        `**Note:** This question relates to ${question.targetPerson} ` +
          `(mentioned in story; not confirmed present in chat). ` +
          `Ask the group warmly without addressing them by name.`,
      );
    }
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

/**
 * Build the system prompt for formatting a historian response with warmth.
 *
 * @param config - Family configuration containing personality settings
 * @param questionLanguage - The detected language of the original question
 * @returns The filled system prompt for response formatting
 */
export function buildResponseSystemPrompt(
  config: FamilyConfig,
  questionLanguage: LanguageCode,
): string {
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
    QUESTION_LANGUAGE: questionLanguage,
    CULTURAL_TERMS:
      culturalTerms.length > 0 ? culturalTerms.join(', ') : 'none',
  };

  return loadPrompt('facilitatorResponse', values);
}

/**
 * Build the user prompt for formatting a historian response.
 *
 * @param originalQuestion - The original question that was asked
 * @param historianAnswer - The raw answer from the historian
 * @returns The user prompt with question and answer context
 */
export function buildResponseUserPrompt(
  originalQuestion: string,
  historianAnswer: string,
): string {
  const parts: string[] = [];

  parts.push(
    'Please format this answer warmly for the family member who asked.',
  );
  parts.push('');
  parts.push('## Original Question');
  parts.push(originalQuestion);
  parts.push('');
  parts.push("## Historian's Answer");
  parts.push(historianAnswer);
  parts.push('');
  parts.push(
    'Transform this into a warm, conversational response in the same language as the question. ' +
      'Preserve all source attributions and factual content. Output ONLY the final message text.',
  );

  return parts.join('\n');
}
