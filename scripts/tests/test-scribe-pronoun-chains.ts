#!/usr/bin/env npx tsx
/**
 * Test Scribe's pronoun resolution with various possessive chains.
 * Standalone - doesn't rely on build system.
 * Run with: npx tsx scripts/tests/test-scribe-pronoun-chains.ts
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';

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

interface TestCase {
  name: string;
  sender: string;
  context: string[];
  message: string;
  /** Substring(s) that should appear in response — any match passes */
  expectedInResponse: string | string[];
  /** Substrings that should NOT appear in subjects/people (lowercased) */
  forbiddenInSubjects?: string[];
}

const testCases: TestCase[] = [
  {
    name: 'Basic possessive chain: her parents',
    sender: 'Betty',
    context: [
      'she was always pretty cruel',
      'although, his sister seemed delighted by it',
      'ralphy never recovered after losing the highschool football game',
    ],
    message: "I don't know why her parents were great",
    // LLM may resolve "her" to "Ralphy's sister" or just "the sister" —
    // either indicates correct pronoun resolution
    expectedInResponse: 'sister',
    forbiddenInSubjects: ['her parents', 'she'],
  },
  {
    name: 'Simple pronoun: his brother',
    sender: 'John',
    context: ['Walter turned 25 yesterday'],
    message: 'his brother is older',
    expectedInResponse: 'walter',
    forbiddenInSubjects: ['his brother'],
  },
  {
    name: 'Pronoun chain: her recipe (through Mom → grandma)',
    sender: 'Mary',
    context: ['Mom made gallo pinto', 'She learned it from grandma'],
    message: 'her recipe was the best',
    // "her" can reasonably resolve to grandma or Mom — both are valid
    // referents in this context
    expectedInResponse: ['grandma', 'mom'],
    forbiddenInSubjects: ['her recipe'],
  },
  {
    name: 'First person resolution',
    sender: 'Carlos',
    context: ['Maria is my sister', 'She lives in Mexico'],
    message: 'I visited her last year',
    expectedInResponse: 'carlos',
    forbiddenInSubjects: ['i visited'],
  },
  {
    name: 'Possessive chain: their house',
    sender: 'Alex',
    context: ['The Smiths moved here in 1990', 'They built a beautiful garden'],
    message: 'their house is on Main Street',
    expectedInResponse: 'smith',
    forbiddenInSubjects: ['their house'],
  },
  {
    name: "Multi-hop: her mother (wife's mother)",
    sender: 'Tom',
    context: ["Uncle Bob's wife is named Linda", 'She was born in Texas'],
    message: 'her mother lived nearby',
    expectedInResponse: 'linda',
    forbiddenInSubjects: ['her mother'],
  },
  {
    name: '"I thought it was X" pattern',
    sender: 'Tom',
    context: ["Alex is Beth's brother"],
    message: 'I thought it was Carl',
    expectedInResponse: 'tom',
  },
];

async function runTest(
  anthropic: Anthropic,
  systemPrompt: string,
  testCase: TestCase,
): Promise<{ passed: boolean; response: string }> {
  const currentDate = new Date();
  const dateStr = currentDate.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });

  const contextLines = testCase.context
    .map((msg) => `${testCase.sender}: ${msg}`)
    .join('\n');

  const userMessage = `TODAY: ${dateStr}

CONTEXT:
${contextLines}

MESSAGE from ${testCase.sender}:
${testCase.message}

Extract from this MESSAGE. Short follow-ups like "and beets" contain information—use context to interpret.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const textContent = response.content.find((c) => c.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    return { passed: false, response: 'No text content' };
  }

  const responseLower = textContent.text.toLowerCase();

  // Check if any expected substring appears in response
  const expectedList = Array.isArray(testCase.expectedInResponse)
    ? testCase.expectedInResponse
    : [testCase.expectedInResponse];
  const hasExpected = expectedList.some((e) =>
    responseLower.includes(e.toLowerCase()),
  );

  // Check for forbidden patterns in subjects
  // Look for patterns like "subject: X" or "name: X" that contain forbidden strings
  let hasForbidden = false;
  if (testCase.forbiddenInSubjects) {
    for (const forbidden of testCase.forbiddenInSubjects) {
      // Check if forbidden string appears as a subject
      const subjectPattern = new RegExp(
        `(subject|name)["']?\\s*:\\s*["']?${forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
        'i',
      );
      if (subjectPattern.test(textContent.text)) {
        hasForbidden = true;
        break;
      }
    }
  }

  const passed = hasExpected && !hasForbidden;

  return {
    passed,
    response: textContent.text,
  };
}

async function main() {
  const anthropic = new Anthropic();

  const systemPrompt = loadPromptFromFile('scribe.txt', {
    SCRIBE_NAME: 'Scribe',
    CULTURAL_TERMS: '(none configured)',
    THOROUGHNESS: 'standard',
    CONFIDENCE: 'moderate',
    PRIMARY_LANGUAGE: 'en',
  });

  console.log('=== Scribe Pronoun Resolution Chain Tests ===\n');

  let passCount = 0;
  let failCount = 0;

  for (const testCase of testCases) {
    try {
      const { passed, response } = await runTest(
        anthropic,
        systemPrompt,
        testCase,
      );

      // Extract subjects from response for display
      const subjectMatches =
        response.match(/subject["']?\s*:\s*["']?([^"'\n,}]+)/gi) || [];
      const subjects = subjectMatches
        .map((m) => m.replace(/subject["']?\s*:\s*["']?/i, '').trim())
        .filter((s) => s.length > 0);

      if (passed) {
        passCount++;
        console.log(`✅ ${testCase.name}`);
        console.log(`   Message:  "${testCase.message}"`);
        console.log(
          `   Subjects: ${subjects.join(', ') || '(check response)'}`,
        );
      } else {
        failCount++;
        console.log(`❌ ${testCase.name}`);
        console.log(`   Message:  "${testCase.message}"`);
        console.log(
          `   Expected in response: "${testCase.expectedInResponse}"`,
        );
        console.log(`   Subjects found: ${subjects.join(', ') || '(none)'}`);
        if (testCase.forbiddenInSubjects) {
          console.log(
            `   Forbidden: ${testCase.forbiddenInSubjects.join(', ')}`,
          );
        }
      }
    } catch (error) {
      failCount++;
      console.log(`❌ ${testCase.name}`);
      console.log(
        `   Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    console.log();
  }

  console.log('---');
  console.log(`Results: ${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(console.error);
