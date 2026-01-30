#!/usr/bin/env npx tsx
/**
 * Simple test of pronoun resolution logic (without full Intern class)
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';

function loadPromptFromFile(filename: string): string {
  const filePath = path.join(
    process.cwd(),
    'libs/prompts/src/agents',
    filename,
  );
  return fs.readFileSync(filePath, 'utf-8');
}

async function main() {
  const anthropic = new Anthropic();

  const contextMessages = [
    'she was always pretty cruel',
    'although, his sister seemed delighted by it',
    'ralphy never recovered after losing the highschool football game',
    'hi everyone!',
    'I remember the one time ralphy lost his shoes',
  ];

  const messageText = "I don't know why her parents were great";

  console.log('=== Testing Intern Pronoun Resolution ===\n');
  console.log('Original message:');
  console.log(`  "${messageText}"\n`);
  console.log('Context:');
  for (const msg of contextMessages) {
    console.log(`  - ${msg}`);
  }
  console.log('\nExpected: "Ralphy\'s sister\'s parents"\n');

  const systemPrompt = loadPromptFromFile('intern-pronouns.txt');
  const contextLines = contextMessages.map((msg) => `- ${msg}`).join('\n');
  const userPrompt = `CONTEXT (newest first):
${contextLines}

MESSAGE to rewrite:
"${messageText}"

Rewrite this message by replacing pronouns with actual names from context. Output only the rewritten message.`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const textContent = response.content.find((c) => c.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    console.error('No text content in response');
    return;
  }

  const resolvedMessage = textContent.text.trim().replace(/^["']|["']$/g, '');

  console.log('Result:');
  console.log(`  "${resolvedMessage}"`);
  console.log(
    `\nTokens: ${response.usage.input_tokens} in, ${response.usage.output_tokens} out`,
  );
  console.log(
    `Cost: $${(
      (response.usage.input_tokens * 0.4) / 1_000_000 +
      (response.usage.output_tokens * 2) / 1_000_000
    ).toFixed(6)}`,
  );

  // Check if it matches expected output
  const success =
    resolvedMessage.toLowerCase().includes("ralphy's sister") ||
    resolvedMessage.toLowerCase().includes("ralphy's sister's");

  console.log(
    `\n${success ? '✅ SUCCESS' : '❌ FAILED'}: Pronoun resolution ${success ? 'worked' : 'failed'}`,
  );
}

main().catch(console.error);
