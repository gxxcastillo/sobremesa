/**
 * Test script for the Historian agent's question parsing and detection.
 * Run with: npx tsx scripts/test-historian.ts
 */

import {
  isQuestion,
  parseQuestion,
} from '../../libs/agents/historian/src/lib/question-parser';

interface TestCase {
  input: string;
  expectedIsQuestion: boolean;
  expectedType?: string;
  description: string;
}

const testCases: TestCase[] = [
  // Direct questions (should be questions)
  {
    input: 'Who was grandpa Abraham?',
    expectedIsQuestion: true,
    expectedType: 'person_info',
    description: 'Who question about a person',
  },
  {
    input: 'When did the family come to America?',
    expectedIsQuestion: true,
    expectedType: 'timeline',
    description: 'When question about timeline',
  },
  {
    input: 'Where did grandma grow up?',
    expectedIsQuestion: true,
    expectedType: 'location',
    description: 'Where question about location',
  },
  {
    input: 'What happened at the 1962 wedding?',
    expectedIsQuestion: true,
    expectedType: 'event',
    description: 'What question about an event',
  },
  {
    input: 'How is Maria related to Roberto?',
    expectedIsQuestion: true,
    expectedType: 'relationship',
    description: 'How question about relationship',
  },
  {
    input: 'Is it true that grandpa was a baker?',
    expectedIsQuestion: true,
    expectedType: 'verification',
    description: 'Is it true verification question',
  },
  {
    input: 'Tell me about the grocery store story',
    expectedIsQuestion: true,
    expectedType: 'story',
    description: 'Tell me about request',
  },
  {
    input: 'Do you know anything about Uncle David?',
    expectedIsQuestion: true,
    expectedType: 'person_info',
    description: 'Do you know question',
  },
  {
    input: 'Does anyone remember when we moved to Chicago?',
    expectedIsQuestion: true,
    expectedType: 'timeline',
    description: 'Does anyone remember question',
  },
  {
    input: "What's the story about the old house?",
    expectedIsQuestion: true,
    expectedType: 'story',
    description: 'Story question with contraction',
  },
  {
    input: 'Can you tell me about great aunt Rosa?',
    expectedIsQuestion: true,
    expectedType: 'person_info',
    description: 'Can you tell me question',
  },
  {
    input: 'I want to know about the family recipes',
    expectedIsQuestion: true,
    expectedType: 'general',
    description: 'Want to know statement',
  },

  // Statements (should NOT be questions)
  {
    input: 'Grandpa Abraham was a wonderful man.',
    expectedIsQuestion: false,
    description: 'Simple statement about a person',
  },
  {
    input: 'The family came to America in 1952.',
    expectedIsQuestion: false,
    description: 'Statement about timeline',
  },
  {
    input: 'I remember grandma used to make the best cookies.',
    expectedIsQuestion: false,
    description: 'Memory statement',
  },
  {
    input: 'Maria and Roberto were cousins.',
    expectedIsQuestion: false,
    description: 'Relationship statement',
  },
  {
    input: 'Here is a photo from the 1962 wedding.',
    expectedIsQuestion: false,
    description: 'Statement sharing a photo',
  },
  {
    input: 'Thanks for sharing that story!',
    expectedIsQuestion: false,
    description: 'Thank you message',
  },
  {
    input: 'That reminds me of something...',
    expectedIsQuestion: false,
    description: 'Trailing thought',
  },
  {
    input: 'Hello everyone!',
    expectedIsQuestion: false,
    description: 'Greeting',
  },
  {
    input: 'lol that was so funny',
    expectedIsQuestion: false,
    description: 'Casual reaction',
  },

  // Edge cases
  {
    input: 'Who?',
    expectedIsQuestion: true,
    expectedType: 'general',
    description: 'Single word question',
  },
  {
    input: 'Really?',
    expectedIsQuestion: true,
    expectedType: 'general',
    description: 'Single word with question mark',
  },
  {
    input: 'The question is whether we should go.',
    expectedIsQuestion: false,
    description: 'Contains "question" but is a statement',
  },
  {
    input: 'I wonder who that was in the photo',
    expectedIsQuestion: true,
    expectedType: 'general',
    description: 'Wonder statement (implicit question)',
  },
];

function runTests(): void {
  console.log('Testing Historian Question Parser\n');
  console.log('='.repeat(60));

  let passed = 0;
  let failed = 0;

  for (const testCase of testCases) {
    const actualIsQuestion = isQuestion(testCase.input);
    const isQuestionPassed = actualIsQuestion === testCase.expectedIsQuestion;

    let typePassed = true;
    let parsedQuestion = null;

    if (actualIsQuestion && testCase.expectedType) {
      parsedQuestion = parseQuestion(testCase.input);
      typePassed = parsedQuestion.type === testCase.expectedType;
    }

    const allPassed = isQuestionPassed && typePassed;

    if (allPassed) {
      passed++;
      console.log(`\n✅ PASS: ${testCase.description}`);
      console.log(`   Input: "${testCase.input}"`);
      console.log(`   isQuestion: ${actualIsQuestion}`);
      if (parsedQuestion) {
        console.log(`   Type: ${parsedQuestion.type}`);
        if (parsedQuestion.entities.length > 0) {
          console.log(`   Entities: ${parsedQuestion.entities.join(', ')}`);
        }
        if (parsedQuestion.timeReferences.length > 0) {
          console.log(
            `   Time refs: ${parsedQuestion.timeReferences.join(', ')}`,
          );
        }
        if (parsedQuestion.keywords.length > 0) {
          console.log(
            `   Keywords: ${parsedQuestion.keywords.slice(0, 5).join(', ')}`,
          );
        }
      }
    } else {
      failed++;
      console.log(`\n❌ FAIL: ${testCase.description}`);
      console.log(`   Input: "${testCase.input}"`);
      if (!isQuestionPassed) {
        console.log(
          `   isQuestion: expected ${testCase.expectedIsQuestion}, got ${actualIsQuestion}`,
        );
      }
      if (!typePassed && parsedQuestion) {
        console.log(
          `   Type: expected ${testCase.expectedType}, got ${parsedQuestion.type}`,
        );
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(
    `\nResults: ${passed} passed, ${failed} failed out of ${testCases.length} tests`,
  );

  if (failed > 0) {
    process.exit(1);
  }
}

// Additional test for entity extraction
function testEntityExtraction(): void {
  console.log('\n\nTesting Entity Extraction\n');
  console.log('='.repeat(60));

  const entityTests = [
    { input: 'Who was Abraham Garcia?', expectedEntities: ['Abraham Garcia'] },
    {
      input: 'Tell me about Uncle David and Aunt Maria',
      expectedEntities: ['Uncle David', 'Aunt Maria'],
    },
    {
      input: 'What happened in Chicago in 1952?',
      expectedEntities: ['Chicago'],
    },
    {
      input: 'How is Rosa related to Roberto Hernandez?',
      expectedEntities: ['Rosa', 'Roberto Hernandez'],
    },
  ];

  for (const test of entityTests) {
    const parsed = parseQuestion(test.input);
    console.log(`\nInput: "${test.input}"`);
    console.log(`  Entities found: ${parsed.entities.join(', ') || '(none)'}`);
    console.log(`  Expected: ${test.expectedEntities.join(', ')}`);

    const allFound = test.expectedEntities.every((e) =>
      parsed.entities.some(
        (pe) =>
          pe.toLowerCase().includes(e.toLowerCase()) ||
          e.toLowerCase().includes(pe.toLowerCase()),
      ),
    );
    console.log(
      `  ${allFound ? '✅' : '⚠️'} ${allFound ? 'Match' : 'Partial/No match'}`,
    );
  }
}

// Additional test for time reference extraction
function testTimeExtraction(): void {
  console.log('\n\nTesting Time Reference Extraction\n');
  console.log('='.repeat(60));

  const timeTests = [
    { input: 'What happened in 1952?', expectedTimes: ['1952'] },
    { input: 'Tell me about the 1960s', expectedTimes: ['1960s'] },
    {
      input: 'When did grandpa arrive in the early 1900s?',
      expectedTimes: ['1900s'],
    },
    { input: 'What was life like in the fifties?', expectedTimes: ['fifties'] },
  ];

  for (const test of timeTests) {
    const parsed = parseQuestion(test.input);
    console.log(`\nInput: "${test.input}"`);
    console.log(
      `  Time refs found: ${parsed.timeReferences.join(', ') || '(none)'}`,
    );
    console.log(`  Expected: ${test.expectedTimes.join(', ')}`);
  }
}

// Run all tests
runTests();
testEntityExtraction();
testTimeExtraction();

console.log('\n\nAll tests completed!');
