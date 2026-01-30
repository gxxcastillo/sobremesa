#!/usr/bin/env npx tsx
/**
 * Test the Intern's new pronoun resolution capability
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicProvider } from '@sobremesa/ai-provider';
import { InternAgent } from '../../libs/agents/intern/src/lib/intern.js';
import type { MessageContext } from '../libs/queue/src/lib/types.js';

async function main() {
  const anthropic = new Anthropic();
  const provider = new AnthropicProvider(anthropic);

  const intern = new InternAgent({
    provider,
    model: 'claude-haiku-4-5-20251001',
  });

  // Test case from our earlier tests
  const context: MessageContext = {
    recentMessages: [
      {
        id: '1',
        content: 'she was always pretty cruel',
        senderName: 'User',
        occurredAt: new Date(),
      },
      {
        id: '2',
        content: 'although, his sister seemed delighted by it',
        senderName: 'User',
        occurredAt: new Date(),
      },
      {
        id: '3',
        content:
          'ralphy never recovered after losing the highschool football game',
        senderName: 'User',
        occurredAt: new Date(),
      },
      {
        id: '4',
        content: 'hi everyone!',
        senderName: 'User',
        occurredAt: new Date(),
      },
      {
        id: '5',
        content: 'I remember the one time ralphy lost his shoes',
        senderName: 'User',
        occurredAt: new Date(),
      },
    ],
    recentImages: [],
  };

  const messageText = "I don't know why her parents were great";

  console.log('=== Testing Intern Pronoun Resolution ===\n');
  console.log('Original message:');
  console.log(`  "${messageText}"\n`);
  console.log('Context:');
  for (const msg of context.recentMessages) {
    console.log(`  - ${msg.content}`);
  }
  console.log('\nExpected: "Ralphy\'s sister\'s parents"\n');

  const result = await intern.resolvePronouns(messageText, context);

  console.log('Result:');
  console.log(`  "${result.resolvedMessage}"`);
  console.log(`\nTokens used: ${result.tokensUsed || 'N/A'}`);

  // Check if it matches expected output
  const success =
    result.resolvedMessage.toLowerCase().includes("ralphy's sister") ||
    result.resolvedMessage.toLowerCase().includes("ralphy's sister's");

  console.log(
    `\n${success ? '✅ SUCCESS' : '❌ FAILED'}: Pronoun resolution ${success ? 'worked' : 'failed'}`,
  );
}

main().catch(console.error);
