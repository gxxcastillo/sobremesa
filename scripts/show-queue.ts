#!/usr/bin/env npx tsx
import 'dotenv/config';
import { createDatabaseClient } from '../libs/database/src/lib/client.js';

async function main() {
  const client = createDatabaseClient({
    url: process.env['SUPABASE_URL']!,
    anonKey: process.env['SUPABASE_ANON_KEY']!,
    serviceRoleKey: process.env['SUPABASE_SERVICE_ROLE_KEY'],
  });

  const { data, error } = await client
    .from('processing_queue')
    .select('*')
    .order('queued_at', { ascending: false })
    .limit(10);

  if (error) {
    console.error('Error:', error.message);
    return;
  }

  console.log('All queue items:');
  data?.forEach((item) => {
    console.log(
      `  ${item.id.slice(0, 8)}... event=${item.conversation_event_id.slice(
        0,
        8,
      )} status=${item.status} attempts=${item.attempts}`,
    );
    if (item.last_error) {
      console.log(`    last_error: ${item.last_error.slice(0, 60)}...`);
    }
  });
}

main().catch(console.error);
