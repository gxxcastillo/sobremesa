import type { ConversationEvent } from '@sobremesa/shared-types';

export interface FormulationUserPromptInput {
  message: ConversationEvent;
  /** Oldest first. */
  preceding: ConversationEvent[];
  recordBlock: string;
  hints: string[];
  language: 'es' | 'en';
}

/**
 * Builds the per-message user prompt for the formulation call. Ports
 * `buildFormulationUserPrompt` from `.agents/scripts/question-wording.ts`.
 */
export function buildFormulationUserPrompt(
  input: FormulationUserPromptInput,
): string {
  const parts: string[] = [];
  parts.push('## Preceding messages (for context, oldest first)');
  if (input.preceding.length) {
    for (const m of input.preceding) {
      parts.push(
        `${m.actorDisplayName ?? 'unknown'}: ${m.contentOriginal ?? '(no text)'}`,
      );
    }
  } else {
    parts.push('(none -- this is near the start of the conversation)');
  }
  parts.push('');
  parts.push('## The message a story or detail came from');
  parts.push(
    `${input.message.actorDisplayName ?? 'unknown'}: ${input.message.contentOriginal ?? '(no text)'}`,
  );
  parts.push('');
  parts.push(
    '## The family record on the people, places, and events named in that message',
  );
  parts.push(input.recordBlock);
  if (input.hints.length) {
    parts.push('');
    parts.push('## Hints (gaps worth noticing, if truly relevant)');
    for (const h of input.hints) parts.push(`- ${h}`);
  }
  parts.push('');
  parts.push(
    `Write "question" and "story_context" in ${input.language === 'es' ? 'Spanish' : 'English'} if ask is true. Respond with the JSON object only.`,
  );
  return parts.join('\n');
}
