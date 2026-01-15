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

  return loadPrompt('scribe', {
    SCRIBE_NAME: config.scribeName,
    CULTURAL_TERMS: culturalTermsStr,
    THOROUGHNESS: config.thoroughness,
    CONFIDENCE: config.confidence,
    PRIMARY_LANGUAGE: config.primaryLanguage,
  });
}

/**
 * Build the user message with the message to process and context.
 * Note: People and places are no longer included - Registrar handles entity matching.
 */
export function buildUserMessage(
  messageContent: string,
  senderName: string,
  context: ScribeContext,
): string {
  const parts: string[] = [];

  // Add pending questions for answer detection
  if (context.pendingQuestions.length > 0) {
    parts.push('## Pending Questions (check if this message answers any)');
    for (const q of context.pendingQuestions.slice(0, 10)) {
      parts.push(`- [${q.id}] ${q.content}`);
    }
    parts.push('');
  }

  // Add recent claims for conflict detection
  if (context.recentClaims.length > 0) {
    parts.push('## Recent Claims (check for conflicts)');
    for (const claim of context.recentClaims.slice(0, 10)) {
      parts.push(
        `- ${claim.subject}: ${JSON.stringify(claim.claimValue)} (by ${
          claim.claimedBy
        })`,
      );
    }
    parts.push('');
  }

  // Add recent messages for context
  if (context.recentMessages.length > 0) {
    parts.push('## Recent Conversation Context');
    for (const msg of context.recentMessages.slice(0, 5)) {
      parts.push(`[${msg.senderName}]: ${msg.content.slice(0, 300)}...`);
    }
    parts.push('');
  }

  // Add recent images for context
  if (context.recentImages && context.recentImages.length > 0) {
    parts.push('## Recent Images in Conversation');
    parts.push(
      '(If this message describes or references one of these images, note the connection)',
    );
    for (const img of context.recentImages) {
      const imgParts: string[] = [`[${img.id}]`];
      imgParts.push(img.fileType);
      if (img.sharedBy) {
        imgParts.push(`shared by ${img.sharedBy}`);
      }
      if (img.analyzed && img.description) {
        imgParts.push(`- "${img.description}"`);
        if (img.peopleCount) {
          imgParts.push(`(${img.peopleCount} people)`);
        }
        if (img.estimatedEra) {
          imgParts.push(`(~${img.estimatedEra})`);
        }
        if (img.visibleText && img.visibleText.length > 0) {
          imgParts.push(`[text: "${img.visibleText.slice(0, 2).join(', ')}"]`);
        }
      } else {
        imgParts.push('(not yet analyzed)');
      }
      parts.push(imgParts.join(' '));
    }
    parts.push('');
  }

  // Add the main message to process
  parts.push('## Message to Process');
  parts.push(`Sender: ${senderName}`);
  parts.push(`Content: ${messageContent}`);
  parts.push('');
  parts.push(
    'Extract all entities, claims, and questions from this message. Return only valid JSON.',
  );

  return parts.join('\n');
}
