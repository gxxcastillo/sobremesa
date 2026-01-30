#!/usr/bin/env npx tsx
/**
 * Test script to debug Scribe pronoun resolution.
 * Tests the exact scenario from the screenshot.
 * Run with: npx tsx scripts/test-scribe-pronouns.ts
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import {
  buildSystemPrompt,
  buildUserMessage,
} from '../libs/agents/scribe/src/lib/prompt-builder.js';
import { parseScribeResponse } from '../libs/agents/scribe/src/lib/response-parser.js';
import type {
  ScribeConfig,
  ScribeContext,
} from '../libs/agents/scribe/src/lib/types.js';

// The message to extract from (contains "her parents")
const TEST_MESSAGE = `I don't know why her parents were great`;
const TEST_SENDER = 'User';

async function main() {
  const anthropic = new Anthropic();
  const model = 'claude-sonnet-4-5-20250929';

  const config: ScribeConfig = {
    maxTokens: 4096,
    thoroughness: 'standard',
    confidence: 'moderate',
    culturalTerms: [],
    scribeName: 'Scribe',
    primaryLanguage: 'en',
  };

  // Context from the screenshot - in newest-first order
  const context: ScribeContext = {
    recentMessages: [
      {
        content: 'she was always pretty cruel',
        senderName: 'User',
        occurredAt: new Date('2024-01-29T22:31:00'),
      },
      {
        content: 'although, his sister seemed delighted by it',
        senderName: 'User',
        occurredAt: new Date('2024-01-29T22:30:30'),
      },
      {
        content:
          'ralphy never recovered after losing the highschool football game',
        senderName: 'User',
        occurredAt: new Date('2024-01-29T22:30:00'),
      },
      {
        content: 'hi everyone!',
        senderName: 'User',
        occurredAt: new Date('2024-01-29T22:29:30'),
      },
      {
        content: 'I remember the one time ralphy lost his shoes',
        senderName: 'User',
        occurredAt: new Date('2024-01-29T22:29:00'),
      },
    ],
    recentImages: [],
  };

  const systemPrompt = buildSystemPrompt(config);
  const userMessage = buildUserMessage(TEST_MESSAGE, TEST_SENDER, context);

  console.log('=== Testing Pronoun Resolution ===\n');
  console.log('CONTEXT (newest first):');
  for (const msg of context.recentMessages) {
    console.log(`  - "${msg.content}"`);
  }
  console.log('\nMESSAGE to extract from:');
  console.log(`  "${TEST_MESSAGE}"`);
  console.log('\nExpected subject resolution:');
  console.log(
    '  "her parents" → "Ralphy\'s sister\'s parents" (or "Bianca\'s parents")',
  );
  console.log('\n=== Full User Prompt ===\n');
  console.log(userMessage);
  console.log('\n=== Calling Claude API ===\n');

  const response = await anthropic.messages.create({
    model,
    max_tokens: config.maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const textContent = response.content.find((c) => c.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    console.error('No text content in response');
    return;
  }

  console.log('=== Raw Claude Response ===\n');
  console.log(textContent.text);
  console.log('\n');

  const domainModel = parseScribeResponse(
    textContent.text,
    'test-event-id',
    'test-family-id',
  );

  console.log('=== Parsed Domain Model ===\n');
  console.log('People:', domainModel.people.length);
  console.log('Claims:', domainModel.claims.length);
  console.log('\n');

  if (domainModel.people.length > 0) {
    console.log('=== Extracted People ===\n');
    for (const p of domainModel.people) {
      console.log(`- ${p.name}`);
    }
    console.log('\n');
  }

  if (domainModel.claims.length > 0) {
    console.log('=== Extracted Claims ===\n');
    for (const c of domainModel.claims) {
      console.log(
        `- [${c.claimType}] subject: "${c.subject}" | value: "${c.claimValue}"`,
      );
    }
    console.log('\n');
  }

  // Check if pronoun was resolved correctly
  const parentsClaimSubjects = domainModel.claims
    .filter((c) => c.claimValue.toLowerCase().includes('great'))
    .map((c) => c.subject);

  console.log('=== Result ===\n');
  if (parentsClaimSubjects.length === 0) {
    console.log('❌ No claim about parents being great was extracted');
  } else {
    const subject = parentsClaimSubjects[0];
    if (
      subject.toLowerCase().includes('her') ||
      subject.toLowerCase() === 'person'
    ) {
      console.log(
        `❌ FAILED: Subject still contains pronoun or generic term: "${subject}"`,
      );
    } else if (
      subject.toLowerCase().includes('ralphy') ||
      subject.toLowerCase().includes('bianca')
    ) {
      console.log(`✅ SUCCESS: Subject properly resolved to: "${subject}"`);
    } else {
      console.log(
        `⚠️  UNCLEAR: Subject is "${subject}" - check if this is correct`,
      );
    }
  }
}

main().catch(console.error);
