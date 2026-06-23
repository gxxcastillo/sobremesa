#!/usr/bin/env bun
/**
 * Test sending a question via the REAL Facilitator bot.
 * Run with: bun scripts/test-send-question.ts
 */
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { FamilyRepository } from '../../libs/database/src/lib/repositories/family-repository.js';
import { QuestionRepository } from '../../libs/database/src/lib/repositories/question-repository.js';

async function main() {
  const facilitatorToken = process.env['TELEGRAM_BOT_TOKEN_FACILITATOR'];
  if (!facilitatorToken) {
    console.error('TELEGRAM_BOT_TOKEN_FACILITATOR not set');
    process.exit(1);
  }

  const familyRepo = new FamilyRepository();
  const questionRepo = new QuestionRepository();

  // Get family with chat ID
  const families = await familyRepo.findAllActive();
  const family = families.find((f) => f.chatId);

  if (!family || !family.chatId) {
    console.error('No family with chat ID found');
    process.exit(1);
  }

  console.log('Family:', family.name);
  console.log('Chat ID:', family.chatId);

  // Get top pending question
  const pending = await questionRepo.findPending(family.id, 1);
  if (pending.length === 0) {
    console.log('No pending questions');
    process.exit(0);
  }

  const question = pending[0];
  console.log('\nQuestion to ask:');
  console.log('  Priority:', question.priority);
  console.log('  Content:', question.contentOriginal);

  // Create bot and send message
  const bot = new Telegraf(facilitatorToken);

  console.log('\nSending message...');
  try {
    await bot.telegram.sendMessage(family.chatId, question.contentOriginal);
    console.log('Message sent successfully!');

    // Mark as asked
    await questionRepo.markAsked(family.id, question.id);
    console.log('Question marked as asked');
  } catch (error) {
    console.error('Failed to send:', error);
  }
}

main().catch(console.error);
