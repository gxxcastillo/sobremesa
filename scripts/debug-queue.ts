#!/usr/bin/env npx tsx
/**
 * Debug the queue dequeue logic
 */
import 'dotenv/config';
import { getServiceClient } from '../libs/database/src/lib/client.js';

async function main() {
  const client = getServiceClient();
  const lockExpiry = new Date(Date.now() - 300000).toISOString();
  const workerId = 'debug-worker-' + Date.now();

  console.log('Worker ID:', workerId);
  console.log('');

  // Try a simple select to see what's there
  console.log('=== Simple select query ===\n');

  const { data: selectData, error: selectError } = await client
    .from('processing_queue')
    .select('*')
    .eq('status', 'queued')
    .order('queued_at', { ascending: true })
    .limit(3);

  if (selectError) {
    console.log('Select error:', selectError.message);
  } else {
    console.log('Queued items found:', selectData?.length || 0);
    selectData?.forEach((item) => {
      console.log(
        '  -',
        item.id?.slice(0, 8),
        'event:',
        item.conversation_event_id?.slice(0, 8),
        'status:',
        item.status,
      );
    });
  }
  console.log('');

  if (!selectData?.length) {
    console.log('No items to dequeue');
    return;
  }

  // Try the new two-step dequeue
  console.log('=== Testing two-step dequeue ===\n');

  const itemToLock = selectData[0];
  console.log('Item to lock:', itemToLock.id.slice(0, 8));

  const { data: updateData, error: updateError } = await client
    .from('processing_queue')
    .update({
      status: 'processing',
      locked_at: new Date().toISOString(),
      locked_by: workerId,
    })
    .eq('id', itemToLock.id)
    .eq('status', 'queued')
    .select()
    .single();

  if (updateError) {
    console.log('Update error:', updateError.message);
    console.log('Error code:', updateError.code);
  } else {
    console.log('Successfully locked item:');
    console.log('  ID:', updateData.id);
    console.log('  Event:', updateData.conversation_event_id);
    console.log('  Status:', updateData.status);
  }
}

main().catch(console.error);
