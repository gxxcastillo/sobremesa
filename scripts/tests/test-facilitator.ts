#!/usr/bin/env npx tsx
/**
 * Test the Facilitator agent asking questions.
 * Run with: npx tsx scripts/test-facilitator.ts
 */
import 'dotenv/config';
import { FacilitatorAgent } from '../../libs/agents/facilitator/src/lib/facilitator.js';
import { FamilyRepository } from '../../libs/database/src/lib/repositories/family-repository.js';
import { QuestionRepository } from '../../libs/database/src/lib/repositories/question-repository.js';

// Mock message sender that just logs
const mockSender = {
  async sendMessage(
    role: 'facilitator',
    message: { chatId: string | number; text: string },
  ) {
    console.log('\n=== WOULD SEND MESSAGE ===');
    console.log('Role:', role);
    console.log('Chat ID:', message.chatId);
    console.log('Text:', message.text);
    console.log('========================\n');
    return 1;
  },
};

async function main() {
  const familyRepo = new FamilyRepository();
  const questionRepo = new QuestionRepository();

  // Get the first active family with a chat ID
  const families = await familyRepo.findAllActive();
  const family = families.find((f) => f.chatId);

  if (!family) {
    console.log('No family with chat ID found');
    return;
  }

  console.log('Testing with family:', family.name, '(', family.id, ')');
  console.log('Chat ID:', family.chatId);

  // Check pending questions
  const pending = await questionRepo.findPending(family.id, 5);
  console.log('\nPending questions:', pending.length);
  pending.forEach((q) => {
    console.log(`  [${q.priority}] ${q.contentOriginal.slice(0, 60)}...`);
  });

  if (pending.length === 0) {
    console.log('\nNo pending questions to ask');
    return;
  }

  // Create facilitator with mock sender
  const facilitator = new FacilitatorAgent({
    messageSender: mockSender,
    minMinutesBetweenQuestions: 0, // Disable rate limiting for test
  });

  // Ask a question
  console.log('\n=== Testing askNextQuestion ===');
  const result = await facilitator.askNextQuestion(family.id);

  console.log('\nResult:');
  console.log('  Success:', result.success);
  if (result.questionId) {
    console.log('  Question ID:', result.questionId);
    console.log('  Content:', result.questionContent);
  }
  if (result.skippedReason) {
    console.log('  Skipped:', result.skippedReason);
  }
  if (result.error) {
    console.log('  Error:', result.error);
  }

  // Check if question was marked as asked
  if (result.questionId) {
    const updated = await questionRepo.findById(family.id, result.questionId);
    console.log('\nQuestion status after asking:');
    console.log('  Status:', updated?.status);
    console.log('  Asked at:', updated?.askedAt);
  }
}

main().catch(console.error);
