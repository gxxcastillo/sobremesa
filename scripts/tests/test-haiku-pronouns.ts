#!/usr/bin/env npx tsx
/**
 * Test if Haiku can handle pronoun resolution when it's the ONLY task
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

  const systemPrompt = `You are a pronoun resolution specialist. Your ONLY job is to replace pronouns with actual names.

Given a MESSAGE and CONTEXT (recent messages, newest first), rewrite the MESSAGE by replacing all pronouns with the actual people/things they refer to.

Scan CONTEXT from top to bottom to find what pronouns refer to. Follow reference chains:
- "her" might refer to "she" in a previous message
- "she" might refer to "his sister" in an earlier message
- "his sister" refers to the most recent male mentioned

Output ONLY the rewritten message with pronouns replaced. Nothing else.`;

  const userMessage = `CONTEXT (newest first):
${contextMessages.map((msg) => `- ${msg}`).join('\n')}

MESSAGE to rewrite:
"I don't know why her parents were great"

Rewrite this message by replacing "her" with the actual person's name based on context. Output only the rewritten message.`;

  console.log('=== Testing Haiku for Pronoun Resolution ===\n');
  console.log('Task: Replace "her parents" with actual name\n');
  console.log('Expected: "Ralphy\'s sister\'s parents" or similar\n');

  // Test with Haiku
  console.log('--- Testing HAIKU 4.5 ---');
  const haikuResponse = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const haikuText = haikuResponse.content.find((c) => c.type === 'text');
  if (haikuText && haikuText.type === 'text') {
    console.log('Haiku output:', haikuText.text);
    console.log(
      'Tokens:',
      haikuResponse.usage.input_tokens,
      'in,',
      haikuResponse.usage.output_tokens,
      'out',
    );
    console.log(
      'Cost: $' +
        (
          (haikuResponse.usage.input_tokens * 0.4) / 1_000_000 +
          (haikuResponse.usage.output_tokens * 2) / 1_000_000
        ).toFixed(6),
    );
  }

  console.log('\n--- Testing SONNET (for comparison) ---');
  const sonnetResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 200,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const sonnetText = sonnetResponse.content.find((c) => c.type === 'text');
  if (sonnetText && sonnetText.type === 'text') {
    console.log('Sonnet output:', sonnetText.text);
    console.log(
      'Tokens:',
      sonnetResponse.usage.input_tokens,
      'in,',
      sonnetResponse.usage.output_tokens,
      'out',
    );
    console.log(
      'Cost: $' +
        (
          (sonnetResponse.usage.input_tokens * 3) / 1_000_000 +
          (sonnetResponse.usage.output_tokens * 15) / 1_000_000
        ).toFixed(6),
    );
  }
}

main().catch(console.error);
