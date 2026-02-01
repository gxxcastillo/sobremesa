#!/usr/bin/env npx tsx
/**
 * Manually process one queued message to test the full pipeline.
 * Run with: npx tsx scripts/process-one.ts
 */
import 'dotenv/config';
import { createDatabaseClient } from '../libs/database/src/lib/client.js';
import { ProcessingQueueRepository } from '../libs/database/src/lib/repositories/processing-queue-repository.js';
import { ScribeAgent } from '../libs/agents/scribe/src/lib/scribe.js';
import { RegistrarAgent } from '../libs/agents/registrar/src/lib/registrar.js';
import { MessageProcessor } from '../libs/queue/src/lib/processor.js';
import { AnthropicProvider } from '../libs/ai-provider/src/lib/anthropic-provider.js';

async function main() {
  const anthropicApiKey = process.env['ANTHROPIC_API_KEY'];
  if (!anthropicApiKey) {
    console.error('ANTHROPIC_API_KEY not set');
    process.exit(1);
  }

  const client = createDatabaseClient({
    url: process.env['SUPABASE_URL']!,
    anonKey: process.env['SUPABASE_ANON_KEY']!,
    serviceRoleKey: process.env['SUPABASE_SERVICE_ROLE_KEY'],
  });

  const queueRepo = new ProcessingQueueRepository(client);
  const provider = new AnthropicProvider({ apiKey: anthropicApiKey });
  const scribe = new ScribeAgent({
    dbClient: client,
    provider,
    model: 'claude-sonnet-4-5-20250929',
  });
  const registrar = new RegistrarAgent({ dbClient: client });

  // Set up processor
  const processor = new MessageProcessor({ dbClient: client });
  processor.setScribe((eventId, familyId) => scribe.process(eventId, familyId));
  processor.setRegistrar((model, familyId) =>
    registrar.persist(model, familyId),
  );

  // Dequeue one item
  console.log('=== Dequeuing one item ===\n');
  const item = await queueRepo.dequeueAny('manual-test-worker', 300000);

  if (!item) {
    console.log('No queued items found');
    return;
  }

  console.log('Found queued item:');
  console.log('  ID:', item.id);
  console.log('  Event ID:', item.conversationEventId);
  console.log('  Family ID:', item.familyId);
  console.log('  Status:', item.status);
  console.log('');

  // Process it
  console.log('=== Processing message ===\n');
  try {
    const result = await processor.process(
      item.conversationEventId,
      item.familyId,
    );
    console.log('Result:', result);

    if (result.success) {
      await queueRepo.complete(item.familyId, item.id);
      console.log('\nMessage processed and completed successfully!');
    } else {
      await queueRepo.fail(
        item.familyId,
        item.id,
        result.error || 'Unknown error',
        3,
      );
      console.log('\nMessage processing failed:', result.error);
    }
  } catch (error) {
    console.error('Error processing:', error);
    await queueRepo.fail(item.familyId, item.id, String(error), 3);
  }

  // Check questions table
  console.log('\n=== Checking questions table ===\n');
  const { data: questions } = await client
    .from('questions')
    .select('id, content_original, priority, status')
    .eq('family_id', item.familyId)
    .order('created_at', { ascending: false })
    .limit(5);

  console.log('Questions for this family:', questions?.length || 0);
  questions?.forEach((q) => {
    console.log(
      `  - [${q.priority}] "${q.content_original?.slice(0, 60)}..." (${
        q.status
      })`,
    );
  });
}

main().catch(console.error);
