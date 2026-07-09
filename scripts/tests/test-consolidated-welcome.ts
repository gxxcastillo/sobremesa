#!/usr/bin/env bun
/**
 * Test the consolidated welcome message feature.
 * Simulates multiple members joining within the debounce window
 * and verifies they're consolidated into a single welcome message.
 *
 * Run with: bun scripts/tests/test-consolidated-welcome.ts
 */
import 'dotenv/config';
import { createDatabaseClient } from '../../libs/database/src/lib/client.js';
import { MessageIngester } from '../../libs/ingester/src/lib/ingester.js';
import { ProcessingQueueRepository } from '../../libs/database/src/lib/repositories/processing-queue-repository.js';
import { ConversationEventRepository } from '../../libs/database/src/lib/repositories/conversation-event-repository.js';
import { formatMemberJoinPluralMessage } from '../../libs/agents/admin/src/lib/messages.js';

const TEST_FAMILY_ID = '00000000-0000-0000-0000-000000000001';
const TEST_CHAT_ID = 'test-chat-consolidated-123';

async function main() {
  console.log('=== Testing Consolidated Welcome Messages ===\n');

  const client = createDatabaseClient({
    url: process.env['SUPABASE_URL']!,
    anonKey: process.env['SUPABASE_ANON_KEY']!,
    serviceRoleKey: process.env['SUPABASE_SERVICE_ROLE_KEY'],
  });

  const ingester = new MessageIngester({ dbClient: client });
  const queueRepo = new ProcessingQueueRepository(client);
  const eventRepo = new ConversationEventRepository(client);

  // 1. Create a test family
  console.log('--- Step 1: Creating test family ---\n');
  const { error: familyError } = await client.from('families').upsert(
    {
      id: TEST_FAMILY_ID,
      name: 'Test Family',
      chat_id: TEST_CHAT_ID,
      is_active: true,
    },
    { onConflict: 'id' },
  );

  if (familyError) {
    console.log('Family creation error:', familyError.message);
    throw new Error('Failed to create test family');
  } else {
    console.log('Created/updated test family');
  }

  // 2. Simulate 3 members joining rapidly
  console.log('\n--- Step 2: Simulating 3 members joining within 100ms ---\n');

  const members = [
    { id: 'user-alice-123', name: 'Alice', username: 'alice' },
    { id: 'user-bob-456', name: 'Bob', username: 'bob' },
    { id: 'user-carlos-789', name: 'Carlos', username: 'carlos' },
  ];

  const eventIds: string[] = [];
  for (const member of members) {
    const eventId = await ingester.ingestMemberEvent(TEST_FAMILY_ID, {
      source: 'telegram',
      conversationId: TEST_CHAT_ID,
      externalEventId: `join-${member.id}-${Date.now()}`,
      actor: {
        externalId: member.id,
        displayName: member.name,
        username: member.username,
      },
      type: 'join',
      memberStatus: 'member',
      occurredAt: new Date(),
    });
    if (eventId) {
      eventIds.push(eventId);
      console.log(
        `  Ingested join event for ${member.name}: ${eventId.slice(0, 8)}...`,
      );
    }
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 50));
  }

  // 3. Check queue items have processAfter set to the future
  console.log(
    '\n--- Step 3: Verifying queue items have future processAfter ---\n',
  );

  const queueItems = await queueRepo.findPendingByEventIds(
    TEST_FAMILY_ID,
    eventIds,
  );
  console.log(`Found ${queueItems.length} queue items`);

  const now = new Date();
  for (const item of queueItems) {
    const processAfter = new Date(item.processAfter);
    const delayMs = processAfter.getTime() - now.getTime();
    console.log(
      `  Item ${item.id.slice(0, 8)}... processAfter in ${delayMs}ms`,
    );

    if (delayMs < 3000) {
      console.log(
        '  WARNING: processAfter is too soon (expected ~5000ms delay)',
      );
    }
  }

  // 4. Try to dequeue immediately (should return null due to processAfter)
  console.log('\n--- Step 4: Attempting immediate dequeue (should fail) ---\n');

  // dequeueAny() is family-agnostic; this assumes an otherwise-idle local
  // queue, same as scripts/process-one.ts.
  const immediateDequeue = await queueRepo.dequeueAny('test-worker');
  if (immediateDequeue) {
    console.log('WARNING: Dequeued item immediately (debounce not working!)');
    console.log(`  Item: ${immediateDequeue.id}`);
  } else {
    console.log(
      '✓ No items dequeued (debounce is working - items not ready yet)',
    );
  }

  // 5. Check the unprocessed join events
  console.log('\n--- Step 5: Checking unprocessed join events ---\n');

  const unprocessedJoins = await eventRepo.findUnprocessedByType(
    TEST_FAMILY_ID,
    TEST_CHAT_ID,
    'join',
  );
  console.log(`Found ${unprocessedJoins.length} unprocessed join events`);
  for (const evt of unprocessedJoins) {
    console.log(`  - ${evt.actorDisplayName} (${evt.id.slice(0, 8)}...)`);
  }

  // 6. Test the plural message formatting
  console.log('\n--- Step 6: Testing plural message formatting ---\n');

  const memberNames = unprocessedJoins.map(
    (e) => e.actorDisplayName || e.actorUsername || 'friend',
  );

  const message = formatMemberJoinPluralMessage(
    'en',
    memberNames,
    'Test Family',
  );
  console.log(`Formatted message: "${message}"`);

  // Verify format
  const expectedPatterns = [
    /Alice/,
    /Bob/,
    /Carlos/,
    /joined the Test Family chat/,
  ];

  let formatCorrect = true;
  for (const pattern of expectedPatterns) {
    if (!pattern.test(message)) {
      console.log(`  ✗ Missing pattern: ${pattern}`);
      formatCorrect = false;
    }
  }

  if (formatCorrect) {
    console.log('✓ Message format is correct');
  }

  // 7. Wait for debounce and verify dequeue works
  console.log('\n--- Step 7: Waiting for debounce period (5s)... ---\n');

  await new Promise((r) => setTimeout(r, 5500)); // Wait slightly longer than 5s

  const delayedDequeue = await queueRepo.dequeueAny('test-worker');
  if (delayedDequeue) {
    console.log(
      `✓ Dequeued item after debounce: ${delayedDequeue.id.slice(0, 8)}...`,
    );
  } else {
    console.log('✗ Failed to dequeue item after debounce period');
  }

  // Summary
  console.log('\n=== Summary ===');
  console.log(`Events ingested: ${eventIds.length}`);
  console.log(`Queue items with debounce: ${queueItems.length}`);
  console.log(`Immediate dequeue blocked: ${!immediateDequeue ? 'YES' : 'NO'}`);
  console.log(`Delayed dequeue worked: ${delayedDequeue ? 'YES' : 'NO'}`);
  console.log(`Message format correct: ${formatCorrect ? 'YES' : 'NO'}`);

  const allPassed =
    eventIds.length === 3 &&
    queueItems.length === 3 &&
    !immediateDequeue &&
    delayedDequeue &&
    formatCorrect;

  console.log(
    '\n' + (allPassed ? '✓ All tests passed!' : '✗ Some tests failed!'),
  );
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
