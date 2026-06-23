#!/usr/bin/env bun
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

async function test(name: string, system: string, user: string) {
  const anthropic = new Anthropic();
  console.log(`\n=== ${name} ===`);

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 50,
    system,
    messages: [{ role: 'user', content: user }],
  });

  const text = response.content.find((c) => c.type === 'text');
  const result = text?.type === 'text' ? text.text.trim() : 'no text';
  console.log(`Result: "${result}"`);

  const success =
    result.toLowerCase().includes('minnie') &&
    result.toLowerCase().includes('mark was marcus');
  console.log(success ? '✅' : '❌');
}

async function main() {
  console.log('Expected: "Minnie thought Mark was Marcus\'s oldest son"');

  await test(
    'Pattern + explicit I replacement',
    'You rewrite messages to be self-contained.',
    `When someone says "A is B's oldest son" and another person replies "I thought it was C", they mean "I thought C was B's oldest son".

Sender: Minnie
Context: "Ralph is Marcus's oldest son"
Message: "I thought it was Mark"

Replace "I" with the sender's name. Apply the pattern above. Output only the rewritten message.`,
  );

  await test(
    'Simpler pattern',
    'Rewrite messages replacing pronouns with names.',
    `Pattern: "X is Y" + "I thought it was Z" → "[sender] thought Z was Y"

Sender: Minnie
Context: Ralph is Marcus's oldest son
Message: I thought it was Mark

Output only the rewritten message.`,
  );
}

main().catch(console.error);
