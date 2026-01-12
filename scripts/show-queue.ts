#!/usr/bin/env npx tsx
import 'dotenv/config';
import { getServiceClient } from '../libs/database/src/lib/client.js';

async function main() {
  const client = getServiceClient();

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
  data?.forEach(item => {
    console.log(`  ${item.id.slice(0, 8)}... event=${item.conversation_event_id.slice(0, 8)} status=${item.status} attempts=${item.attempts}`);
    if (item.last_error) {
      console.log(`    last_error: ${item.last_error.slice(0, 60)}...`);
    }
  });
}

main().catch(console.error);
