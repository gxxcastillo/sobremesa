#!/usr/bin/env bun
/**
 * Test if Scribe (Sonnet) can handle pronoun resolution inline
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

const SCRIBE_PROMPT_WITH_PRONOUNS = `You are a family historian documenting family history. Extract data precisely.

## Step 1: Resolve Pronouns

First, resolve all pronouns to understand the full meaning:
- "I/me/my" → the sender's name
- "he/she/they/her/his" → trace through context to the actual person
- "it" in "I thought it was X" after "A is B" → sender thought X was B

## Step 2: Extract

From the understood message, extract people, events, and claims.

Output ONLY valid JSON (no commentary):
{"understood_message": "...", "people": [], "events": [], "claims": []}`;

async function main() {
  const anthropic = new Anthropic();

  const testCases = [
    {
      name: 'I thought it was X pattern',
      sender: 'Minnie',
      context: ["Donald: Ralph is Marcus's oldest son"],
      message: 'I thought it was Mark?',
      check: (msg: string) =>
        msg.toLowerCase().includes('minnie') &&
        msg.toLowerCase().includes('mark was marcus'),
    },
    {
      name: 'Simple I replacement',
      sender: 'Maria',
      context: ['John: When did you move to Texas?'],
      message: 'I moved there in 1985',
      check: (msg: string) =>
        msg.toLowerCase().includes('maria') &&
        msg.toLowerCase().includes('1985'),
    },
    {
      name: 'Reference chain',
      sender: 'Betty',
      context: [
        'Tom: Ralphy never got over losing the football game',
        'Sue: His sister was so mean about it',
      ],
      message: 'She still teases him at family dinners',
      check: (msg: string) =>
        msg.toLowerCase().includes('ralphy') &&
        msg.toLowerCase().includes('sister'),
    },
  ];

  console.log('Testing Scribe with inline pronoun resolution\n');

  for (const test of testCases) {
    console.log(`=== ${test.name} ===`);
    console.log(`Message: "${test.message}"`);

    const userPrompt = `SENDER: ${test.sender}

CONTEXT:
${test.context.map((c) => `- ${c}`).join('\n')}

MESSAGE:
"${test.message}"`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: SCRIBE_PROMPT_WITH_PRONOUNS,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = response.content.find((c) => c.type === 'text');
    if (text?.type === 'text') {
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = text.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          const understood = parsed.understood_message || '';
          console.log(`Understood: "${understood}"`);
          console.log(test.check(understood) ? '✅' : '❌');
        } catch {
          console.log(`Parse error: ${text.text.slice(0, 150)}`);
        }
      } else {
        console.log(`No JSON: ${text.text.slice(0, 150)}`);
      }
    }
    console.log();
  }
}

main().catch(console.error);
