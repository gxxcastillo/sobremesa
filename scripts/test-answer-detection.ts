#!/usr/bin/env npx tsx
/**
 * Test the answer detection flow.
 * Run with: npx tsx scripts/test-answer-detection.ts
 */
import 'dotenv/config';
import { FamilyRepository } from '../libs/database/src/lib/repositories/family-repository.js';
import { QuestionRepository } from '../libs/database/src/lib/repositories/question-repository.js';
import { getServiceClient } from '../libs/database/src/lib/client.js';

async function main() {
  const familyRepo = new FamilyRepository();
  const questionRepo = new QuestionRepository();
  const client = getServiceClient();

  // Get family
  const families = await familyRepo.findAllActive();
  const family = families.find((f) => f.chatId);

  if (!family) {
    console.log('No family with chat ID found');
    return;
  }

  console.log('=== Family ===');
  console.log('Name:', family.name);
  console.log('');

  // Check questions with external message IDs
  console.log('=== Questions with External Message IDs ===');
  const { data: questionsWithExternalId } = await client
    .from('questions')
    .select('id, content_original, status, asked_external_message_id, asked_at, answered_at')
    .eq('family_id', family.id)
    .not('asked_external_message_id', 'is', null)
    .order('asked_at', { ascending: false })
    .limit(10);

  if (!questionsWithExternalId?.length) {
    console.log('No questions with external message IDs yet.');
    console.log('Run test-send-question.ts or send a message to trigger the facilitator.');
  } else {
    console.log(`Found ${questionsWithExternalId.length} questions with external IDs:\n`);
    for (const q of questionsWithExternalId) {
      console.log(`  [${q.status}] ${q.content_original.slice(0, 50)}...`);
      console.log(`    External ID: ${q.asked_external_message_id}`);
      console.log(`    Asked at: ${q.asked_at}`);
      if (q.answered_at) {
        console.log(`    Answered at: ${q.answered_at}`);
      }
      console.log('');
    }
  }

  // Check for recent answer events
  console.log('=== Recent Answer Events ===');
  const { data: answerEvents } = await client
    .from('event_log')
    .select('*')
    .eq('family_id', family.id)
    .eq('event_type', 'question_answered')
    .order('created_at', { ascending: false })
    .limit(5);

  if (!answerEvents?.length) {
    console.log('No answer detection events yet.');
    console.log('\nTo test:');
    console.log('1. The facilitator asks a question');
    console.log('2. Reply to that question in Telegram (use the reply feature)');
    console.log('3. The system should detect the reply and mark the question as answered');
  } else {
    console.log(`Found ${answerEvents.length} answer detection events:\n`);
    for (const e of answerEvents) {
      const data = e.event_data as Record<string, unknown>;
      console.log(`  Question: ${(data.questionContent as string || '').slice(0, 50)}...`);
      console.log(`  Detected at: ${e.created_at}`);
      console.log('');
    }
  }

  // Summary stats
  console.log('=== Question Status Summary ===');
  const proposed = await questionRepo.findByStatus(family.id, 'proposed');
  const asked = await questionRepo.findByStatus(family.id, 'asked');
  const answered = await questionRepo.findByStatus(family.id, 'answered');

  console.log('Proposed:', proposed.length);
  console.log('Asked:', asked.length);
  console.log('Answered:', answered.length);
}

main().catch(console.error);
