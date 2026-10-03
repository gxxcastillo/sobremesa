#!/usr/bin/env bun
/**
 * Live-DB integration tests for the consolidated join welcome's retry path
 * (outbound-send-reliability-plan.md, the "newcomer never welcomed" gap):
 * a retry after the welcome was already sent must not absorb a member who
 * joined in between, or the ledger skips the send and that member is marked
 * done without ever being named. A retry after a provably failed send still
 * absorbs them, because it really sends.
 *
 * Drives a real `AdminAgent` against the real queue, events and outbound
 * ledger. The Telegram send is faked, but goes through
 * `OutboundMessageRepository.claim()` the way `BotManager` does, so the
 * duplicate/reclaim decisions are the real ones. No onboarding: the agent
 * is built from repositories, not a dbClient, so no identities are written
 * outside the throwaway family.
 *
 * Each scenario creates its own family and deletes it in `finally`. Manual
 * only. Requires `bun nx run db:start`.
 *
 * Run with: bun nx run tests:live --file=test-join-welcome-retry.ts
 */
import 'dotenv/config';
import {
  ConversationEventRepository,
  EventLogRepository,
  FamilyRepository,
  OutboundMessageRepository,
  ProcessingQueueRepository,
  type DatabaseClient,
} from '@sobremesa/database';
import { AdminAgent } from '@sobremesa/agents-admin';
import {
  MessageDeliveryError,
  type MessageSender,
  type SendOutcome,
} from '@sobremesa/shared-types';
import {
  createLiveDbClient,
  randomSuffix,
  runScenarios,
  type ScenarioResult,
} from './live-db-test-utils.js';

interface Ctx {
  client: DatabaseClient;
  familyId: string;
  chatId: string;
  queueRepo: ProcessingQueueRepository;
  outboundRepo: OutboundMessageRepository;
}

/** A Telegram stand-in that claims through the real ledger, like BotManager. */
class LedgerSender implements MessageSender {
  delivered: string[] = [];
  failNextDelivery = false;

  constructor(private outboundRepo: OutboundMessageRepository) {}

  async sendMessage(
    role: Parameters<MessageSender['sendMessage']>[0],
    message: Parameters<MessageSender['sendMessage']>[1],
    options?: Parameters<MessageSender['sendMessage']>[2],
  ): Promise<SendOutcome> {
    const dedup = options?.dedup;
    if (!dedup) throw new Error('join welcome must be dedup-keyed');
    const claim = await this.outboundRepo.claim({
      familyId: dedup.familyId,
      dedupKey: dedup.key,
      role,
      chatId: message.chatId,
      content: message.text,
      conversationEventId: dedup.conversationEventId,
    });
    if (claim.outcome === 'duplicate') return { status: 'duplicate' };
    if (claim.outcome === 'ambiguous') return { status: 'unconfirmed' };

    if (this.failNextDelivery) {
      this.failNextDelivery = false;
      await this.outboundRepo.confirmFailed(
        dedup.familyId,
        claim.message.id,
        '400: Bad Request (simulated)',
      );
      throw new MessageDeliveryError('400: Bad Request (simulated)');
    }
    this.delivered.push(message.text);
    await this.outboundRepo.confirmSent(dedup.familyId, claim.message.id, '1');
    return { status: 'sent', messageId: 1 };
  }
}

async function main(): Promise<void> {
  const allowRemoteDb = process.argv.includes('--allow-remote-db');
  const client = createLiveDbClient('Join welcome retry tests', allowRemoteDb);

  await runScenarios(
    [
      {
        name: 'retry after a sent welcome leaves a new join for its own welcome',
        run: () => withFamily(client, retryAfterSent),
      },
      {
        name: 'retry after a failed welcome absorbs the new join',
        run: () => withFamily(client, retryAfterFailed),
      },
    ],
    {
      allPassed: 'All join welcome retry scenarios passed.',
      someFailed: (count) => `${count} join welcome retry scenario(s) failed.`,
    },
  );
}

// --- scenarios ---------------------------------------------------------------

async function retryAfterSent(ctx: Ctx): Promise<ScenarioResult> {
  const name =
    'retry after a sent welcome leaves a new join for its own welcome';
  const sender = new LedgerSender(ctx.outboundRepo);
  const admin = createAdmin(ctx, sender);

  const alice = await joinAndLease(ctx, 'Alice');
  const first = await admin.handle(alice, ctx.familyId, 'member_event');
  // Crash after the send: Alice's row is never completed, so it is retried.
  const marta = await join(ctx, 'Marta');
  const retry = await admin.handle(alice, ctx.familyId, 'member_event');
  const martaAfterRetry = await queueStatus(ctx, marta);

  await ctx.queueRepo.markProcessing(
    ctx.familyId,
    await queueId(ctx, marta),
    'test',
  );
  const own = await admin.handle(marta, ctx.familyId, 'member_event');

  const passed =
    first.success &&
    retry.success &&
    own.success &&
    martaAfterRetry === 'queued' &&
    sender.delivered.length === 2 &&
    sender.delivered[0].includes('Alice') &&
    !sender.delivered[0].includes('Marta') &&
    sender.delivered[1].includes('Marta');
  return {
    name,
    passed,
    detail: `Marta after retry: ${martaAfterRetry}; delivered: ${JSON.stringify(sender.delivered)}`,
  };
}

async function retryAfterFailed(ctx: Ctx): Promise<ScenarioResult> {
  const name = 'retry after a failed welcome absorbs the new join';
  const sender = new LedgerSender(ctx.outboundRepo);
  const admin = createAdmin(ctx, sender);

  const alice = await joinAndLease(ctx, 'Alice');
  sender.failNextDelivery = true;
  const first = await admin.handle(alice, ctx.familyId, 'member_event');
  const marta = await join(ctx, 'Marta');
  const retry = await admin.handle(alice, ctx.familyId, 'member_event');
  const martaAfterRetry = await queueStatus(ctx, marta);

  const passed =
    !first.success &&
    retry.success &&
    martaAfterRetry === 'done' &&
    sender.delivered.length === 1 &&
    sender.delivered[0].includes('Alice') &&
    sender.delivered[0].includes('Marta');
  return {
    name,
    passed,
    detail: `first.success=${first.success}; Marta after retry: ${martaAfterRetry}; delivered: ${JSON.stringify(sender.delivered)}`,
  };
}

// --- fixtures ----------------------------------------------------------------

function createAdmin(ctx: Ctx, sender: MessageSender): AdminAgent {
  return new AdminAgent({
    messageSender: sender,
    eventRepo: new ConversationEventRepository(ctx.client),
    familyRepo: new FamilyRepository(ctx.client),
    eventLog: new EventLogRepository(ctx.client),
    queueRepo: ctx.queueRepo,
    outboundRepo: ctx.outboundRepo,
  });
}

async function join(ctx: Ctx, displayName: string): Promise<string> {
  const now = new Date().toISOString();
  const { data, error } = await ctx.client
    .from('conversation_events')
    .insert({
      family_id: ctx.familyId,
      source: 'telegram',
      conversation_id: ctx.chatId,
      external_event_id: `join-retry-${randomSuffix()}`,
      actor_external_id: `user-${displayName.toLowerCase()}-${randomSuffix()}`,
      actor_display_name: displayName,
      event_type: 'join',
      language_original: 'en',
      metadata: {},
      source_payload: {},
      occurred_at: now,
      ingested_at: now,
    })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(`Failed to insert join event: ${error?.message}`);
  }
  const eventId = String(data.id);
  await ctx.queueRepo.enqueue(ctx.familyId, eventId);
  return eventId;
}

/** A join whose queue row is leased, as `dequeueAny` leaves the trigger. */
async function joinAndLease(ctx: Ctx, displayName: string): Promise<string> {
  const eventId = await join(ctx, displayName);
  await ctx.queueRepo.markProcessing(
    ctx.familyId,
    await queueId(ctx, eventId),
    'test',
  );
  return eventId;
}

async function queueId(ctx: Ctx, eventId: string): Promise<string> {
  const item = await ctx.queueRepo.findByEventId(ctx.familyId, eventId);
  if (!item) throw new Error(`No queue row for event ${eventId}`);
  return item.id;
}

async function queueStatus(
  ctx: Ctx,
  eventId: string,
): Promise<string | undefined> {
  return (await ctx.queueRepo.findByEventId(ctx.familyId, eventId))?.status;
}

async function withFamily(
  client: DatabaseClient,
  run: (ctx: Ctx) => Promise<ScenarioResult>,
): Promise<ScenarioResult> {
  const chatId = `join-retry-${randomSuffix()}`;
  const { data, error } = await client
    .from('families')
    .insert({
      name: 'Join Retry Test',
      chat_source: 'telegram',
      chat_id: chatId,
      config: {},
    })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(`Failed to create test family: ${error?.message}`);
  }
  const familyId = String(data.id);
  try {
    return await run({
      client,
      familyId,
      chatId,
      queueRepo: new ProcessingQueueRepository(client),
      outboundRepo: new OutboundMessageRepository(client),
    });
  } finally {
    await client.rpc('delete_family_cascade', { p_family_id: familyId });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
