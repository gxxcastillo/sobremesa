#!/usr/bin/env npx tsx
/**
 * Show what Intern sends to Scribe after pronoun resolution
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

async function main() {
  const anthropic = new Anthropic();

  const contextMessages = [
    'she was always pretty cruel',
    'although, his sister seemed delighted by it',
    'ralphy never recovered after losing the highschool football game',
    'hi everyone!',
    'I remember the one time ralphy lost his shoes',
  ];

  const originalMessage = "I don't know why her parents were great";

  console.log('=== CURRENT FLOW (Broken) ===\n');
  console.log('Message sent to Scribe:');
  console.log(`  "${originalMessage}"`);
  console.log('\nScribe has to:');
  console.log('  1. Resolve "her" to actual name');
  console.log(
    '  2. Extract people, places, events, claims, stories, relationships',
  );
  console.log('  3. Follow JSON schema');
  console.log('\nResult: Cognitive overload → "Ralphy\'s parents" (WRONG)\n');

  console.log('=== NEW FLOW (with Intern preprocessing) ===\n');

  // Step 1: Intern resolves pronouns
  const internPrompt = `You are a pronoun resolution specialist. Your ONLY job is to replace pronouns with actual names.

Given a MESSAGE and CONTEXT (recent messages, newest first), rewrite the MESSAGE by replacing all pronouns with the actual people/things they refer to.

Scan CONTEXT from top to bottom to find what pronouns refer to. Follow reference chains:
- "her" might refer to "she" in a previous message
- "she" might refer to "his sister" in an earlier message
- "his sister" refers to the most recent male mentioned

Output ONLY the rewritten message with pronouns replaced. Nothing else.`;

  const internUserMessage = `CONTEXT (newest first):
${contextMessages.map((msg) => `- ${msg}`).join('\n')}

MESSAGE to rewrite:
"${originalMessage}"

Rewrite this message by replacing pronouns with actual names from context. Output only the rewritten message.`;

  console.log('Step 1: Intern (Haiku 4.5) resolves pronouns\n');

  const internResponse = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    system: internPrompt,
    messages: [{ role: 'user', content: internUserMessage }],
  });

  const resolvedMessage = internResponse.content.find((c) => c.type === 'text');
  const resolvedText =
    resolvedMessage && resolvedMessage.type === 'text'
      ? resolvedMessage.text.replace(/^["']|["']$/g, '') // Remove quotes
      : originalMessage;

  console.log('Input to Intern:');
  console.log(`  "${originalMessage}"`);
  console.log('\nOutput from Intern:');
  console.log(`  "${resolvedText}"`);
  console.log(
    `\nCost: $${(
      (internResponse.usage.input_tokens * 0.4) / 1_000_000 +
      (internResponse.usage.output_tokens * 2) / 1_000_000
    ).toFixed(6)}`,
  );

  console.log('\n' + '='.repeat(60) + '\n');

  // Step 2: Show what gets sent to Scribe
  console.log('Step 2: Scribe (Sonnet 4.5) receives pre-resolved message\n');

  console.log('Message sent to Scribe:');
  console.log(`  "${resolvedText}"`);
  console.log('\nScribe now has to:');
  console.log('  1. ✅ Pronouns already resolved!');
  console.log(
    '  2. Extract people, places, events, claims, stories, relationships',
  );
  console.log('  3. Follow JSON schema');
  console.log('\nResult: Reduced cognitive load → Accurate extraction\n');

  console.log('=== COMPARISON ===\n');
  console.log('BEFORE (sent to Scribe):');
  console.log(`  "${originalMessage}"`);
  console.log('\nAFTER (sent to Scribe):');
  console.log(`  "${resolvedText}"`);
  console.log(
    '\n✅ Scribe extracts from pre-resolved text with no pronoun ambiguity',
  );
}

main().catch(console.error);
