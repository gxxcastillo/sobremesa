#!/usr/bin/env bun
/**
 * Standalone test for pronoun resolution - doesn't rely on build system
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';

// Read and fill prompt template manually
function loadPromptFromFile(
  filename: string,
  values: Record<string, string> = {},
): string {
  const filePath = path.join(
    process.cwd(),
    'libs/prompts/src/agents',
    filename,
  );
  let template = fs.readFileSync(filePath, 'utf-8');

  for (const [key, value] of Object.entries(values)) {
    const placeholder = `{${key}}`;
    template = template.replace(
      new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'),
      value,
    );
  }

  return template;
}

async function main() {
  const anthropic = new Anthropic();
  const model = 'claude-sonnet-4-5-20250929'; // Back to Sonnet to verify it still fails

  // Build system prompt
  const systemPrompt = loadPromptFromFile('scribe.txt', {
    SCRIBE_NAME: 'Scribe',
    CULTURAL_TERMS: '(none configured)',
    THOROUGHNESS: 'standard',
    CONFIDENCE: 'moderate',
    PRIMARY_LANGUAGE: 'en',
  });

  // Build user message with context
  const currentDate = new Date();
  const dateStr = currentDate.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });

  // Test 1: Minimal context (what Scribe receives with 5-message window)
  const contextMessages = [
    'she was always pretty cruel',
    'although, his sister seemed delighted by it',
    'ralphy never recovered after losing the highschool football game',
    'hi everyone!',
    'I remember the one time ralphy lost his shoes',
  ];

  // Test 2: With additional clarifying messages (if they were in window)
  const extendedContext = [
    "I think Ralphy's sisters name was 'Bianca'",
    'I think their names were betty and tim',
    ...contextMessages,
  ];

  // Run Test 1: Minimal context
  console.log('=== Testing FULL SCRIBE EXTRACTION with SONNET 4.5 ===\n');
  console.log('=== TEST 1: Minimal Context (5 messages) ===\n');
  console.log('CONTEXT (newest first):');
  for (const msg of contextMessages) {
    console.log(`  - "${msg}"`);
  }
  console.log('\nExpected: "her parents" → "Ralphy\'s sister\'s parents"');

  const userMessage1 = `TODAY: ${dateStr}

CONTEXT:
${contextMessages.map((msg) => `User: ${msg}`).join('\n')}

MESSAGE from User:
I don't know why her parents were great

Extract from this MESSAGE. CRITICAL: Replace all pronouns (he/she/they) with actual names from CONTEXT. Never output a pronoun as subject. Short follow-ups like "and beets" contain information—use context to interpret.`;

  console.log('\n=== Calling Claude API (Test 1) ===\n');

  const response1 = await anthropic.messages.create({
    model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage1 }],
  });

  const textContent1 = response1.content.find((c) => c.type === 'text');
  if (!textContent1 || textContent1.type !== 'text') {
    console.error('No text content in response');
    return;
  }

  console.log('=== Response (Test 1) ===\n');
  console.log('Token usage:');
  console.log(`  Input: ${response1.usage.input_tokens} tokens`);
  console.log(`  Output: ${response1.usage.output_tokens} tokens\n`);

  checkResult(textContent1.text, 'Test 1');

  // Test 2: Extended context with name clarifications
  console.log('\n\n=== TEST 2: Extended Context (with names) ===\n');
  console.log('CONTEXT (newest first):');
  for (const msg of extendedContext) {
    console.log(`  - "${msg}"`);
  }
  console.log(
    '\nExpected: "her parents" → "Bianca\'s parents" or "Ralphy\'s sister\'s parents"',
  );

  const userMessage2 = `TODAY: ${dateStr}

CONTEXT:
${extendedContext.map((msg) => `User: ${msg}`).join('\n')}

MESSAGE from User:
I don't know why her parents were great

Extract from this MESSAGE. CRITICAL: Replace all pronouns (he/she/they) with actual names from CONTEXT. Never output a pronoun as subject. Short follow-ups like "and beets" contain information—use context to interpret.`;

  console.log('\n=== Calling Claude API (Test 2) ===\n');

  const response2 = await anthropic.messages.create({
    model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage2 }],
  });

  const textContent2 = response2.content.find((c) => c.type === 'text');
  if (!textContent2 || textContent2.type !== 'text') {
    console.error('No text content in response');
    return;
  }

  console.log('=== Response (Test 2) ===\n');
  checkResult(textContent2.text, 'Test 2');
}

function checkResult(responseText: string, testName: string) {
  // Parse JSON from response
  try {
    const jsonMatch = responseText.match(/```json\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1]);

      if (parsed.claims && parsed.claims.length > 0) {
        console.log('Claims:');
        for (const claim of parsed.claims) {
          console.log(
            `  [${claim.claim_type}] subject: "${claim.subject}" | value: "${claim.claim_value}"`,
          );
        }

        // Check if pronoun was resolved correctly
        const parentsClaimSubjects = parsed.claims
          .filter(
            (c: { claim_value: string }) =>
              c.claim_value.toLowerCase().includes('great') ||
              c.claim_value.toLowerCase().includes('parent'),
          )
          .map((c: { subject: string }) => c.subject);

        console.log('\nResult:');
        if (parentsClaimSubjects.length === 0) {
          console.log(
            `  ❌ ${testName} FAILED: No claim about parents was extracted`,
          );
        } else {
          const subject = parentsClaimSubjects[0];
          if (
            subject.toLowerCase().includes('her') ||
            subject.toLowerCase() === 'person'
          ) {
            console.log(
              `  ❌ ${testName} FAILED: Subject still contains pronoun/generic term: "${subject}"`,
            );
          } else if (
            subject.toLowerCase().includes('sister') ||
            subject.toLowerCase().includes('bianca')
          ) {
            console.log(
              `  ✅ ${testName} SUCCESS: Subject correctly resolved to: "${subject}"`,
            );
          } else if (
            subject.toLowerCase().includes('ralphy') &&
            !subject.toLowerCase().includes('sister')
          ) {
            console.log(
              `  ⚠️  ${testName} PARTIAL: Subject is "${subject}" (should be "Ralphy's sister's parents" or "Bianca's parents")`,
            );
          } else {
            console.log(`  ⚠️  ${testName} UNCLEAR: Subject is "${subject}"`);
          }
        }
      } else {
        console.log('  No claims extracted');
      }
    }
  } catch (e) {
    console.error('  Failed to parse JSON:', e);
  }
}

main().catch(console.error);
