import { loadPrompt } from '@sobremesa/prompts';
import type { ScribeConfig, ScribeContext } from './types';

/**
 * Build the system prompt with config values substituted.
 */
export function buildSystemPrompt(config: ScribeConfig): string {
  const culturalTermsStr =
    config.culturalTerms.length > 0
      ? config.culturalTerms.join(', ')
      : '(none configured)';

  const prompt = loadPrompt('scribe', {
    SCRIBE_NAME: config.scribeName,
    CULTURAL_TERMS: culturalTermsStr,
    THOROUGHNESS: config.thoroughness,
    CONFIDENCE: config.confidence,
    PRIMARY_LANGUAGE: config.primaryLanguage,
  });

  console.log(
    '[Scribe] System prompt length:',
    prompt.length,
    'chars, estimated tokens:',
    Math.ceil(prompt.length / 4),
  );

  return prompt;
}

/**
 * Build the user message with the message to process and context.
 * Note: People and places are no longer included - Registrar handles entity matching.
 */
export function buildUserMessage(
  messageContent: string,
  senderName: string,
  context: ScribeContext,
  messageTimestamp?: Date,
): string {
  console.log('[Scribe] Context stats:', {
    recentMessageCount: context.recentMessages.length,
    recentImageCount: context.recentImages?.length || 0,
    messageContentLength: messageContent.length,
  });

  const parts: string[] = [];

  // Add current date context for resolving relative dates
  const currentDate = messageTimestamp || new Date();
  const dateStr = currentDate.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });
  parts.push(`TODAY: ${dateStr}`);
  parts.push('');

  // Add recent messages for context
  if (context.recentMessages.length > 0) {
    parts.push('CONTEXT:');
    for (const msg of context.recentMessages.slice(0, 5)) {
      const truncated =
        msg.content.length > 200
          ? msg.content.slice(0, 200) + '...'
          : msg.content;
      parts.push(`${msg.senderName}: ${truncated}`);
    }
    parts.push('');
  }

  // Add recent images for context (compact format)
  if (context.recentImages && context.recentImages.length > 0) {
    parts.push('IMAGES:');
    for (const img of context.recentImages) {
      const imgParts: string[] = [`[${img.id.slice(0, 8)}]`];
      if (img.analyzed && img.description) {
        imgParts.push(img.description.slice(0, 80));
        if (img.peopleCount) imgParts.push(`${img.peopleCount}ppl`);
        if (img.estimatedEra) imgParts.push(`~${img.estimatedEra}`);
      } else {
        imgParts.push(img.fileType);
        if (img.sharedBy) imgParts.push(`by ${img.sharedBy}`);
      }
      parts.push(imgParts.join(' '));
    }
    parts.push('');
  }

  // Add the main message to process
  parts.push(`MESSAGE from ${senderName}:`);
  parts.push(messageContent);
  parts.push('');
  parts.push(
    'Extract from this MESSAGE. CRITICAL: Replace all pronouns (he/she/they) with actual names from CONTEXT. Never output a pronoun as subject. Short follow-ups like "and beets" contain information—use context to interpret.',
  );

  const finalMessage = parts.join('\n');
  console.log(
    '[Scribe] Final user message length:',
    finalMessage.length,
    'chars, estimated tokens:',
    Math.ceil(finalMessage.length / 4),
  );

  return finalMessage;

  return parts.join('\n');
}
