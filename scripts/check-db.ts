#!/usr/bin/env bun
/**
 * Check database state for debugging.
 * Run with: bun scripts/check-db.ts
 */
import 'dotenv/config';
import { createDatabaseClient } from '../libs/database/src/lib/client.js';

async function main() {
  const client = createDatabaseClient({
    url: process.env['SUPABASE_URL']!,
    anonKey: process.env['SUPABASE_ANON_KEY']!,
    serviceRoleKey: process.env['SUPABASE_SERVICE_ROLE_KEY'],
  });

  console.log('=== Database State ===\n');

  // Check families
  const { data: families, error: famErr } = await client
    .from('families')
    .select('id, name, created_at')
    .limit(5);

  if (famErr) {
    console.error('Error fetching families:', famErr.message);
  } else {
    console.log('Families:', families?.length || 0);
    families?.forEach((f) => console.log(`  - ${f.name} (${f.id})`));
  }
  console.log('');

  // Check recent conversation events
  const { data: events, error: evtErr } = await client
    .from('conversation_events')
    .select('id, family_id, content_original, processed, occurred_at')
    .order('occurred_at', { ascending: false })
    .limit(5);

  if (evtErr) {
    console.error('Error fetching events:', evtErr.message);
  } else {
    console.log('Recent conversation events:', events?.length || 0);
    events?.forEach((e) => {
      const content =
        e.content_original?.slice(0, 50) +
        (e.content_original?.length > 50 ? '...' : '');
      console.log(
        `  - ${e.id.slice(0, 8)}... processed=${e.processed} "${content}"`,
      );
    });
  }
  console.log('');

  // Check questions
  const { data: questions, error: qErr } = await client
    .from('questions')
    .select('id, family_id, content_original, priority, status, created_at')
    .order('created_at', { ascending: false })
    .limit(10);

  if (qErr) {
    console.error('Error fetching questions:', qErr.message);
  } else {
    console.log('Questions in database:', questions?.length || 0);
    questions?.forEach((q) => {
      console.log(
        `  - [${q.priority}] "${q.content_original?.slice(0, 60)}..." (${
          q.status
        })`,
      );
    });
  }
  console.log('');

  // Check processing queue
  const { data: queue, error: queErr } = await client
    .from('processing_queue')
    .select('id, family_id, conversation_event_id, status, queued_at')
    .order('queued_at', { ascending: false })
    .limit(5);

  if (queErr) {
    console.error('Error fetching queue:', queErr.message);
  } else {
    console.log('Processing queue:', queue?.length || 0);
    queue?.forEach((q) =>
      console.log(
        `  - ${q.conversation_event_id?.slice(0, 8)}... status=${q.status}`,
      ),
    );
  }
  console.log('');

  // Check event log for recent processing
  const { data: logs, error: logErr } = await client
    .from('event_log')
    .select('id, family_id, event_type, actor, event_data, created_at')
    .order('created_at', { ascending: false })
    .limit(10);

  if (logErr) {
    console.error('Error fetching logs:', logErr.message);
  } else {
    console.log('Recent event log entries:', logs?.length || 0);
    logs?.forEach((l) => {
      const data = l.event_data
        ? JSON.stringify(l.event_data).slice(0, 80)
        : '';
      console.log(`  - ${l.event_type} by ${l.actor}: ${data}`);
    });
  }
}

main().catch(console.error);
