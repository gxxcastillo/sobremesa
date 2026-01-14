#!/usr/bin/env npx tsx
import 'dotenv/config';
import { getServiceClient } from '../libs/database/src/lib/client.js';

async function main() {
  const client = getServiceClient();

  // Force reset all non-done items
  const { data, error } = await client
    .from('processing_queue')
    .update({
      status: 'queued',
      locked_at: null,
      locked_by: null,
      last_error: null,
      attempts: 0,
    })
    .neq('status', 'done')
    .select();

  if (error) {
    console.error('Error:', error.message);
    return;
  }

  console.log('Force reset', data?.length || 0, 'items');
  data?.forEach((d) =>
    console.log(`  - ${d.conversation_event_id.slice(0, 8)}... now queued`)
  );
}

main().catch(console.error);
