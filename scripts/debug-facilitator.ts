#!/usr/bin/env npx tsx
/**
 * Debug why Facilitator isn't asking questions
 */
import 'dotenv/config';
import { createDatabaseClient } from '../libs/database/src/lib/client.js';
import { FamilyRepository } from '../libs/database/src/lib/repositories/family-repository.js';
import { QuestionRepository } from '../libs/database/src/lib/repositories/question-repository.js';

async function main() {
  console.log('=== Environment Check ===\n');
  console.log(
    'TELEGRAM_BOT_TOKEN_FACILITATOR:',
    process.env['TELEGRAM_BOT_TOKEN_FACILITATOR'] ? 'SET' : 'NOT SET',
  );
  console.log('');

  const client = createDatabaseClient({
    url: process.env['SUPABASE_URL']!,
    anonKey: process.env['SUPABASE_ANON_KEY']!,
    serviceRoleKey: process.env['SUPABASE_SERVICE_ROLE_KEY'],
  });
  const familyRepo = new FamilyRepository(client);
  const questionRepo = new QuestionRepository(client);

  // Get family
  const families = await familyRepo.findAllActive();
  const family = families.find((f) => f.chatId);

  if (!family) {
    console.log('No family with chat ID');
    return;
  }

  console.log('=== Family ===');
  console.log('Name:', family.name);
  console.log('Chat ID:', family.chatId);
  console.log('');

  // Check questions by status
  const proposed = await questionRepo.findByStatus(family.id, 'proposed');
  const asked = await questionRepo.findByStatus(family.id, 'asked');
  const answered = await questionRepo.findByStatus(family.id, 'answered');

  console.log('=== Questions by Status ===');
  console.log('Proposed:', proposed.length);
  console.log('Asked:', asked.length);
  console.log('Answered:', answered.length);
  console.log('');

  // Check last asked question timing
  if (asked.length > 0) {
    const mostRecent = asked.reduce((latest, q) => {
      if (!q.askedAt) return latest;
      if (!latest.askedAt) return q;
      return new Date(q.askedAt) > new Date(latest.askedAt) ? q : latest;
    }, asked[0]);

    if (mostRecent.askedAt) {
      const askedAt = new Date(mostRecent.askedAt);
      const minutesAgo = (Date.now() - askedAt.getTime()) / (1000 * 60);
      console.log('=== Last Asked Question ===');
      console.log('Content:', mostRecent.contentOriginal.slice(0, 50) + '...');
      console.log('Asked at:', mostRecent.askedAt);
      console.log('Minutes ago:', minutesAgo.toFixed(1));
      console.log(
        'Rate limit (5 min) would block:',
        minutesAgo < 5 ? 'YES' : 'NO',
      );
    }
  }
  console.log('');

  // Check recent event log for facilitator activity
  console.log('=== Recent Facilitator Events ===');
  const { data: logs } = await client
    .from('event_log')
    .select('*')
    .eq('actor', 'facilitator')
    .order('created_at', { ascending: false })
    .limit(5);

  if (!logs?.length) {
    console.log('No facilitator events found');
  } else {
    logs.forEach((l) => {
      const data = l.event_data
        ? JSON.stringify(l.event_data).slice(0, 80)
        : '';
      console.log(`  ${l.event_type}: ${data}`);
      console.log(`    at: ${l.created_at}`);
    });
  }
}

main().catch(console.error);
