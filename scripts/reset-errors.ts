#!/usr/bin/env npx tsx
import 'dotenv/config';
import { getServiceClient } from '../libs/database/src/lib/client.js';

async function main() {
  const client = getServiceClient();

  // Find and reset error items
  const { data, error } = await client
    .from('processing_queue')
    .update({
      status: 'queued',
      locked_at: null,
      locked_by: null,
      last_error: null,
      attempts: 0,
    })
    .eq('status', 'error')
    .select();

  if (error) {
    console.error('Error:', error.message);
    return;
  }

  console.log('Reset', data?.length || 0, 'error items to queued status');
}

main().catch(console.error);
