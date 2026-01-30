#!/usr/bin/env npx tsx
/**
 * Test pronoun resolution with various possessive chains
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

interface TestCase {
  name: string;
  sender: string;
  context: string[];
  message: string;
  expected: string; // substring that should appear in result
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
    expected: "ralphy's sister's parents",
  },
  {
    name: 'Event reference: delighted by it',
    sender: 'Betty',
    context: [
      'she was always pretty cruel',
      'ralphy never recovered after losing the highschool football game',
    ],
    message: 'his sister seemed delighted by it',
    expected: 'losing the',
  },
  {
    name: 'Simple pronoun: his brother',
    sender: 'John',
    context: ['Walter turned 25 yesterday'],
    message: 'his brother is older',
    expected: "walter's brother",
  },
  {
    name: 'Pronoun chain: her recipe (through Mom → grandma)',
    sender: 'Mary',
    context: ['Mom made gallo pinto', 'She learned it from grandma'],
    message: 'her recipe was the best',
    expected: "grandma's recipe",
  },
  {
    name: 'First person + third person combo',
    sender: 'Carlos',
    context: ['Maria is my sister', 'She lives in Mexico'],
    message: 'I visited her last year',
    expected: 'carlos visited maria',
  },
  {
    name: 'Possessive chain: their house',
    sender: 'Alex',
    context: ['The Smiths moved here in 1990', 'They built a beautiful garden'],
    message: 'their house is on Main Street',
    expected: "the smiths' house",
  },
  {
    name: "Multi-hop: his wife's mother",
    sender: 'Tom',
    context: ["Uncle Bob's wife is named Linda", 'She was born in Texas'],
    message: 'her mother lived nearby',
    expected: "linda's mother",
  },
  // "It" resolution tests
  {
    name: 'It → decision/action',
    sender: 'Rosa',
    context: ['My grandparents decided to leave Cuba in 1959'],
    message: 'they never regretted it',
    expected: 'leaving cuba',
  },
  {
    name: 'It → object',
    sender: 'David',
    context: [
      "Grandma's wedding ring was passed down",
      'Mom wore it at her wedding',
    ],
    message: 'she gave it to me last year',
    expected: 'wedding ring',
  },
  {
    name: 'It → place',
    sender: 'Anna',
    context: ['The family farm was in Iowa', 'We spent every summer there'],
    message: 'I miss it so much',
    expected: 'the family farm',
  },
  {
    name: 'It → activity/skill',
    sender: 'Mike',
    context: ['Dad taught me to play guitar'],
    message: 'he was so patient when teaching it',
    expected: 'guitar',
  },
  {
    name: 'That → event (demonstrative)',
    sender: 'Lucy',
    context: ['Uncle Joe won the lottery in 1987'],
    message: 'nobody believed that actually happened',
    expected: 'lottery',
  },
  // Idiomatic "it" - should NOT be resolved
  {
    name: 'Idiomatic it: weather (should not resolve)',
    sender: 'Maria',
    context: ['The wedding was in June 1985'],
    message: 'it was raining that day',
    expected: 'it was raining',
  },
  {
    name: 'Idiomatic it: existential (should not resolve)',
    sender: 'Tom',
    context: ['Grandpa worked in the coal mines'],
    message: 'it was hard to make ends meet',
    expected: 'it was hard',
  },
];

async function runTest(
  anthropic: Anthropic,
  systemPrompt: string,
  testCase: TestCase,
): Promise<{ passed: boolean; result: string }> {
  const contextLines = testCase.context.map((msg) => `- ${msg}`).join('\n');
  const userPrompt = `SENDER: ${testCase.sender}

CONTEXT (newest first):
${contextLines}

MESSAGE to rewrite:
"${testCase.message}"

Rewrite this message by replacing ALL pronouns with actual names. Output only the rewritten message.`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const textContent = response.content.find((c) => c.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    return { passed: false, result: 'No text content' };
  }

  const result = textContent.text.trim().replace(/^["']|["']$/g, '');
  const passed = result.toLowerCase().includes(testCase.expected.toLowerCase());

  return { passed, result };
}

async function main() {
  const anthropic = new Anthropic();
  const promptFile = process.argv[2] || 'intern-pronouns.txt';
  console.log(`Using prompt: ${promptFile}\n`);
  const systemPrompt = loadPromptFromFile(promptFile);

  console.log('=== Pronoun Resolution Chain Tests ===\n');

  let passCount = 0;
  let failCount = 0;

  for (const testCase of testCases) {
    const { passed, result } = await runTest(anthropic, systemPrompt, testCase);

    if (passed) {
      passCount++;
      console.log(`✅ ${testCase.name}`);
      console.log(`   Input:    "${testCase.message}"`);
      console.log(`   Output:   "${result}"`);
    } else {
      failCount++;
      console.log(`❌ ${testCase.name}`);
      console.log(`   Input:    "${testCase.message}"`);
      console.log(`   Expected: "${testCase.expected}"`);
      console.log(`   Got:      "${result}"`);
    }
    console.log();
  }

  console.log('---');
  console.log(`Results: ${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(console.error);
