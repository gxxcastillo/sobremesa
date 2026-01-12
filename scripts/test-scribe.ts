#!/usr/bin/env npx tsx
/**
 * Test script to debug Scribe question generation.
 * Run with: npx tsx scripts/test-scribe.ts
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt, buildUserMessage } from '../libs/agents/scribe/src/lib/prompt-builder.js';
import { parseScribeResponse } from '../libs/agents/scribe/src/lib/response-parser.js';
import type { ScribeConfig, ScribeContext } from '../libs/agents/scribe/src/lib/types.js';

const TEST_MESSAGE = `My grandfather Abraham came to America sometime in the 1920s.
I think he came from Poland but I'm not 100% sure. He opened a small grocery store
when he arrived but I don't know exactly where it was located.`;

const TEST_SENDER = 'TestUser';

async function main() {
  const anthropic = new Anthropic();

  const config: ScribeConfig = {
    model: 'claude-sonnet-4-20250514',
    maxTokens: 4096,
    thoroughness: 'standard',
    confidence: 'moderate',
    culturalTerms: [],
    scribeName: 'Scribe',
  };

  const context: ScribeContext = {
    recentMessages: [],
    existingPeople: [],
    existingPlaces: [],
    pendingQuestions: [],
    recentClaims: [],
  };

  const systemPrompt = buildSystemPrompt(config);
  const userMessage = buildUserMessage(TEST_MESSAGE, TEST_SENDER, context);

  console.log('=== Calling Claude API ===\n');
  console.log('Test message:', TEST_MESSAGE);
  console.log('\n');

  const response = await anthropic.messages.create({
    model: config.model,
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
    TEST_SENDER
  );

  console.log('=== Parsed Domain Model ===\n');
  console.log('People:', domainModel.people.length);
  console.log('Places:', domainModel.places.length);
  console.log('Events:', domainModel.events.length);
  console.log('Claims:', domainModel.claims.length);
  console.log('Questions:', domainModel.questions.length);
  console.log('\n');

  if (domainModel.questions.length > 0) {
    console.log('=== Generated Questions ===\n');
    for (const q of domainModel.questions) {
      console.log(`- "${q.content}"`);
      console.log(`  Priority: ${q.priority}, Target: ${q.targetPerson || q.targetEvent || q.targetPlace || 'none'}`);
    }
  } else {
    console.log('*** NO QUESTIONS GENERATED ***');
    console.log('This might indicate Claude is not outputting questions in its response.');
  }
}

main().catch(console.error);
