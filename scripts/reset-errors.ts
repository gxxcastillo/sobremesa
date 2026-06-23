#!/usr/bin/env bun
import 'dotenv/config';
import { createDatabaseClient } from '../libs/database/src/lib/client.js';

async function main() {
  const client = createDatabaseClient({
    url: process.env['SUPABASE_URL']!,
    anonKey: process.env['SUPABASE_ANON_KEY']!,
    serviceRoleKey: process.env['SUPABASE_SERVICE_ROLE_KEY'],
  });

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
