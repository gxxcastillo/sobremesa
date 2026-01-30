#!/usr/bin/env npx tsx
/**
 * Test script to debug Scribe entity extraction.
 * Run with: npx tsx scripts/test-scribe.ts
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import {
  buildSystemPrompt,
  buildUserMessage,
} from '../../libs/agents/scribe/src/lib/prompt-builder.js';
import { parseScribeResponse } from '../../libs/agents/scribe/src/lib/response-parser.js';
import type {
  ScribeConfig,
  ScribeContext,
} from '../../libs/agents/scribe/src/lib/types.js';

const TEST_MESSAGE = `My grandfather Abraham came to America sometime in the 1920s.
I think he came from Poland but I'm not 100% sure. He opened a small grocery store
when he arrived but I don't know exactly where it was located.`;

const TEST_SENDER = 'TestUser';

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

  const context: ScribeContext = {
    recentMessages: [],
    recentImages: [],
  };

  const systemPrompt = buildSystemPrompt(config);
  const userMessage = buildUserMessage(TEST_MESSAGE, TEST_SENDER, context);

  console.log('=== Calling Claude API ===\n');
  console.log('Test message:', TEST_MESSAGE);
  console.log('\n');

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
  console.log('Places:', domainModel.places.length);
  console.log('Events:', domainModel.events.length);
  console.log('Claims:', domainModel.claims.length);
  console.log('Relationships:', domainModel.relationships.length);
  console.log('Story:', domainModel.story ? 'Yes' : 'No');
  console.log('\n');

  if (domainModel.people.length > 0) {
    console.log('=== Extracted People ===\n');
    for (const p of domainModel.people) {
      console.log(`- ${p.name}`);
      if (p.aliases.length > 0) {
        console.log(`  Aliases: ${p.aliases.join(', ')}`);
      }
    }
  }

  if (domainModel.claims.length > 0) {
    console.log('\n=== Extracted Claims ===\n');
    for (const c of domainModel.claims) {
      console.log(`- [${c.claimType}] ${c.subject}: ${c.claimValue}`);
      if (c.certaintyLanguage) {
        console.log(`  Certainty: "${c.certaintyLanguage}"`);
      }
    }
  }
}

main().catch(console.error);
