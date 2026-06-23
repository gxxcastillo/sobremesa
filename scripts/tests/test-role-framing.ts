#!/usr/bin/env bun
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

async function test(name: string, system: string, user: string) {
  const anthropic = new Anthropic();

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 50,
    system,
    messages: [{ role: 'user', content: user }],
  });

  const text = response.content.find((c) => c.type === 'text');
  const result =
    text?.type === 'text'
      ? text.text.trim().replace(/^["']|["']$/g, '')
      : 'no text';
  const lower = result.toLowerCase();
  // Check that both "mark" and "marcus" appear — LLM may phrase as
  // "Mark was Marcus's" or "Mark who was Marcus's oldest son" etc.
  const success =
    lower.includes('minnie') &&
    lower.includes('mark') &&
    lower.includes('marcus');

  console.log(`${name}: "${result}" ${success ? '✅' : '❌'}`);
}

const systemPrompt = `You understand conversational pragmatics - what people mean beyond literal words.

When someone says "I thought it was X" in response to "A is B", they mean they believed X was B.

Rewrite the message replacing "I" with the sender's name and making the full meaning explicit.

Output ONLY the rewritten message.`;

async function main() {
  console.log('Expected: "Minnie thought Mark was Marcus\'s oldest son"\n');

  // Structured format
  await test(
    'Structured format',
    systemPrompt,
    `SENDER: Minnie
CONTEXT: Donald said "Ralph is Marcus's oldest son"
MESSAGE: "I thought it was Mark?"`,
  );

  // Prose format
  await test(
    'Prose format',
    systemPrompt,
    `Donald said "Ralph is Marcus's oldest son"
Minnie replied "I thought it was Mark?"

Rewrite Minnie's message:`,
  );

  // Hybrid format
  await test(
    'Hybrid format',
    systemPrompt,
    `In response to "Ralph is Marcus's oldest son", Minnie said "I thought it was Mark?"

Rewrite Minnie's message:`,
  );
}

main().catch(console.error);
