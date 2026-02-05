import { loadPrompt } from '@sobremesa/prompts';
import { createLogger } from '@sobremesa/shared-utils';
import type { ScribeConfig, ScribeContext } from './types';

const logger = createLogger({ name: 'scribe', level: 'debug' });

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

  logger.debug(
    { length: prompt.length, estimatedTokens: Math.ceil(prompt.length / 4) },
    'System prompt built',
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
  timezone?: string,
): string {
  logger.debug(
    {
      recentMessageCount: context.recentMessages.length,
      recentImageCount: context.recentImages?.length || 0,
      messageContentLength: messageContent.length,
    },
    'Building user message',
  );

  const parts: string[] = [];

  // Add current date context for resolving relative dates
  // Use family timezone to ensure dates match user's local perspective
  const currentDate = messageTimestamp || new Date();
  const dateOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    ...(timezone && { timeZone: timezone }),
  };
  const dateStr = currentDate.toLocaleDateString('en-US', dateOptions);
  parts.push(`TODAY: ${dateStr}`);
  parts.push('');

  // Add recent messages for context (already filtered by character limit)
  if (context.recentMessages.length > 0) {
    parts.push('CONTEXT:');
    for (const msg of context.recentMessages) {
      parts.push(`${msg.senderName}: ${msg.content}`);
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
    'Extract from this MESSAGE. Short follow-ups like "and beets" contain information—use context to interpret.',
  );

  const finalMessage = parts.join('\n');
  logger.debug(
    {
      length: finalMessage.length,
      estimatedTokens: Math.ceil(finalMessage.length / 4),
    },
    'User message built',
  );

  return finalMessage;
}
