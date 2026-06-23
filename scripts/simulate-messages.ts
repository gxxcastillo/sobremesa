#!/usr/bin/env bun
/**
 * Mock chat provider — feeds scenario messages into the running chatbot.
 *
 * Creates a new family per run, injects messages via the ingester, and waits
 * for the running chatbot's queue worker to process them. No pipeline wiring
 * needed — the chatbot handles everything.
 *
 * Usage:
 *   bun scripts/simulate-messages.ts                          # list scenarios
 *   bun scripts/simulate-messages.ts ralphy-shoes             # run scenario (new family)
 *   bun scripts/simulate-messages.ts ralphy-shoes --family ID # run on existing family
 *   bun scripts/simulate-messages.ts ralphy-shoes --reset     # clear DB first
 *   bun scripts/simulate-messages.ts ralphy-shoes --dump      # save snapshot to snapshots/
 */
import 'dotenv/config';
import { execSync, spawn } from 'child_process';
import { createDatabaseClient } from '../libs/database/src/lib/client.js';
import {
  MessageIngester,
  type TextMessageInput,
} from '../libs/ingester/src/index.js';

// ---------------------------------------------------------------------------
// Sender profiles
// ---------------------------------------------------------------------------
const senders = {
  mickey: {
    externalId: '1854820684',
    displayName: 'Mickey',
    username: 'mickey-mouse',
  },
  minnie: {
    externalId: '8342506173',
    displayName: 'Minnie',
    username: 'minnie-mouse',
  },
  donald: {
    externalId: '5927301846',
    displayName: 'Donald',
    username: 'donald-duck',
  },
  daisy: {
    externalId: '3041628957',
    displayName: 'Daisy',
    username: 'daisy-duck',
  },
  goofy: {
    externalId: '7468205139',
    displayName: 'Goofy',
    username: 'goofy-dog',
  },
} as const;

type SenderKey = keyof typeof senders;

interface SimMessage {
  sender: SenderKey;
  text: string;
  replyTo?: number; // index of message being replied to (0-based)
}

// ---------------------------------------------------------------------------
// Test scenarios
// ---------------------------------------------------------------------------
const scenarios: Record<
  string,
  { description: string; messages: SimMessage[] }
> = {
  'ralphy-shoes': {
    description:
      'Ralphy losing shoes + football game (pronoun resolution, continuation)',
    messages: [
      {
        sender: 'mickey',
        text: 'remember the one time ralphy lost his shoes?',
      },
      {
        sender: 'mickey',
        text: 'he never recovered after losing the highschool football game',
      },
      { sender: 'minnie', text: 'Which game?' },
      { sender: 'mickey', text: 'the one against van wilder high' },
    ],
  },
  'marcus-family': {
    description: 'Family relationships + disagreement (conflict detection)',
    messages: [
      { sender: 'mickey', text: "Ralph is Marcus's oldest son" },
      { sender: 'minnie', text: 'I thought it was Mark?' },
      {
        sender: 'mickey',
        text: 'no Mark is the second oldest, Ralph was born in 1983',
      },
      {
        sender: 'minnie',
        text: 'are you sure? I remember Marcus saying Mark was born first',
      },
    ],
  },
  'trip-story': {
    description: 'Extended story with places, dates, and multiple people',
    messages: [
      {
        sender: 'mickey',
        text: 'remember when grandpa took us all to Yosemite in the summer of 92?',
      },
      {
        sender: 'minnie',
        text: 'yes! he drove that old station wagon the whole way from Phoenix',
      },
      { sender: 'mickey', text: 'uncle Roberto came too with his kids' },
      {
        sender: 'minnie',
        text: "wasn't that the trip where Maria fell in the creek?",
      },
      {
        sender: 'mickey',
        text: 'haha yes and grandpa had to fish her out',
      },
    ],
  },
  'family-history': {
    description:
      'Rich multi-generational history: relationships, events, places, conflicts, identity claims, pronoun resolution',
    messages: [
      {
        sender: 'mickey',
        text: "I've been thinking about abuela Rosa's 80th birthday party in Guadalajara",
      },
      {
        sender: 'minnie',
        text: 'that was such a special day, everyone came - uncle Carlos, tía Elena, Sofia and her husband Diego',
      },
      {
        sender: 'donald',
        text: 'grandma moved there from Oaxaca when she was young, I think around 1965',
      },
      { sender: 'daisy', text: 'she was born in 1940 right?' },
      {
        sender: 'donald',
        text: "no I'm pretty sure it was 1939, dad always said she was born right before the war",
      },
      {
        sender: 'goofy',
        text: 'I still miss abuelo Ernesto, he passed away in 2015 right before the party',
      },
      {
        sender: 'mickey',
        text: 'he was a carpenter, he built their house in Guadalajara with his own hands',
      },
      {
        sender: 'daisy',
        text: "remember tía Lupe? she's actually Guadalupe, Elena's older sister",
      },
      {
        sender: 'minnie',
        text: "Sofia's wedding in Puerto Vallarta was beautiful, that was June 2022",
      },
      {
        sender: 'goofy',
        text: 'she looked amazing, and her dad Carlos walked her down the aisle, he cried the whole time',
      },
      {
        sender: 'donald',
        text: "Carlos played guitar at both the birthday and the wedding, he's really talented",
      },
      {
        sender: 'daisy',
        text: "I thought Carlos was a doctor? or maybe that's his brother",
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const familyFlag = args.indexOf('--family');
  const resetFlag = args.includes('--reset');
  const dumpFlag = args.includes('--dump');
  const existingFamilyId = familyFlag !== -1 ? args[familyFlag + 1] : undefined;
  const scenarioName = args.find(
    (a, i) =>
      !a.startsWith('--') && (familyFlag === -1 || i !== familyFlag + 1),
  );

  // List scenarios if none specified
  if (!scenarioName) {
    console.log('Available scenarios:\n');
    for (const [name, scenario] of Object.entries(scenarios)) {
      console.log(`  ${name}`);
      console.log(`    ${scenario.description}`);
      console.log(`    ${scenario.messages.length} messages\n`);
    }
    console.log(
      'Usage: bun scripts/simulate-messages.ts <scenario> [--family <id>] [--reset] [--dump]',
    );
    process.exit(0);
  }

  if (!scenarios[scenarioName]) {
    console.error(`Unknown scenario: ${scenarioName}`);
    console.error(`Available: ${Object.keys(scenarios).join(', ')}`);
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // Optional DB reset
  // -------------------------------------------------------------------------
  if (resetFlag) {
    const dbUrl =
      process.env['DATABASE_URL'] ??
      'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
    console.log('Resetting database...');
    try {
      execSync(
        `psql "${dbUrl}" -c "TRUNCATE families, users, sequence_counters CASCADE;"`,
        { stdio: 'pipe' },
      );
      console.log('Database cleared.\n');
    } catch {
      console.error('Failed to reset DB. Is local supabase running?');
      process.exit(1);
    }
  }

  // -------------------------------------------------------------------------
  // Environment
  // -------------------------------------------------------------------------
  const supabaseUrl = process.env['SUPABASE_URL'];
  const supabaseAnonKey = process.env['SUPABASE_ANON_KEY'];
  const supabaseServiceRoleKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY');
    process.exit(1);
  }

  const dbClient = createDatabaseClient({
    url: supabaseUrl,
    anonKey: supabaseAnonKey,
    serviceRoleKey: supabaseServiceRoleKey,
  });

  // -------------------------------------------------------------------------
  // Family setup
  // -------------------------------------------------------------------------
  let familyId: string;
  let familyName: string;
  let chatId: string;

  if (existingFamilyId) {
    const { data, error } = await dbClient
      .from('families')
      .select('id, name, chat_id')
      .eq('id', existingFamilyId)
      .single();

    if (error || !data) {
      console.error(`Family not found: ${existingFamilyId}`);
      process.exit(1);
    }

    familyId = data.id;
    familyName = data.name;
    chatId = data.chat_id || `sim-${Date.now()}`;
    console.log(`Using existing family: ${familyName} (${familyId})`);
  } else {
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, 19);
    familyName = `Sim | ${scenarioName} | ${timestamp}`;
    chatId = `sim-${Date.now()}`;

    const { data, error } = await dbClient
      .from('families')
      .insert({ name: familyName, chat_id: chatId, config: {} })
      .select()
      .single();

    if (error || !data) {
      console.error(`Failed to create family: ${error?.message}`);
      process.exit(1);
    }

    familyId = data.id;
    console.log(`Created family: ${familyName} (${familyId})`);
  }

  // -------------------------------------------------------------------------
  // Ingest messages
  // -------------------------------------------------------------------------
  const scenario = scenarios[scenarioName];
  console.log(
    `\nScenario: ${scenarioName} (${scenario.messages.length} messages)`,
  );
  console.log(`  ${scenario.description}\n`);

  const ingester = new MessageIngester(dbClient);
  const baseMessageId = 90000 + Math.floor(Math.random() * 9000);
  const baseTime = Date.now();
  const eventIds: string[] = [];

  for (let i = 0; i < scenario.messages.length; i++) {
    const msg = scenario.messages[i];
    const sender = senders[msg.sender];
    const messageId = baseMessageId + i;

    const input: TextMessageInput = {
      type: 'text',
      source: 'telegram',
      conversationId: chatId,
      externalEventId: String(messageId),
      externalReplyToId:
        msg.replyTo !== undefined
          ? String(baseMessageId + msg.replyTo)
          : undefined,
      actor: {
        externalId: sender.externalId,
        displayName: sender.displayName,
        username: sender.username,
      },
      text: msg.text,
      occurredAt: new Date(baseTime + i * 2000),
      metadata: { chatType: 'group', chatTitle: familyName },
      sourcePayload: {
        message_id: messageId,
        chat: { id: chatId, type: 'group', title: familyName },
        from: {
          id: Number(sender.externalId),
          is_bot: false,
          first_name: sender.displayName.split(' ')[0],
          username: sender.username,
        },
        text: msg.text,
        date: Math.floor((baseTime + i * 2000) / 1000),
      },
    };

    const eventId = await ingester.ingestTextMessage(familyId, input);
    if (eventId) {
      eventIds.push(eventId);
      console.log(
        `  ingested [${i + 1}/${scenario.messages.length}] ${sender.displayName}: "${msg.text}"`,
      );
    } else {
      console.log(
        `  skipped  [${i + 1}/${scenario.messages.length}] ${sender.displayName}: "${msg.text}" (duplicate)`,
      );
    }

    // Pause between messages so the queue worker (and upstream LLM) aren't
    // hammered with concurrent requests.
    if (i < scenario.messages.length - 1) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  if (eventIds.length === 0) {
    console.log('\nNo new messages to process (all duplicates).');
    process.exit(0);
  }

  // -------------------------------------------------------------------------
  // Wait for the running chatbot's queue worker to process all items
  // -------------------------------------------------------------------------
  console.log(
    `\nWaiting for chatbot to process ${eventIds.length} messages...`,
  );

  const maxWaitMs = 300_000; // 5 minutes
  const pollMs = 2000;
  const startWait = Date.now();

  while (Date.now() - startWait < maxWaitMs) {
    const { data: pending } = await dbClient
      .from('processing_queue')
      .select('id')
      .eq('family_id', familyId)
      .in('status', ['queued', 'processing']);

    if (!pending?.length) {
      break;
    }

    process.stdout.write(`\r  ${pending.length} remaining...  `);
    await new Promise((r) => setTimeout(r, pollMs));
  }

  // Check if any failed
  const { data: failed } = await dbClient
    .from('processing_queue')
    .select('conversation_event_id, last_error')
    .eq('family_id', familyId)
    .eq('status', 'error');

  if (failed?.length) {
    console.log(`\n  ${failed.length} messages failed:`);
    for (const f of failed) {
      console.log(`    ${f.conversation_event_id}: ${f.last_error}`);
    }
  }

  // Check if timed out
  const { data: stillPending } = await dbClient
    .from('processing_queue')
    .select('id')
    .eq('family_id', familyId)
    .in('status', ['queued', 'processing']);

  if (stillPending?.length) {
    console.log(
      `\n  Timed out — ${stillPending.length} messages still pending.`,
    );
    console.log('  Is the chatbot running? (bun nx dev chatbots)');
    process.exit(1);
  }

  console.log('\r  All messages processed.      ');

  // -------------------------------------------------------------------------
  // Dump results
  // -------------------------------------------------------------------------
  // Kick off dump-db in the background if --dump was requested
  const dumpPromise = dumpFlag
    ? new Promise<void>((resolve, reject) => {
        const child = spawn('bun', ['scripts/dump-db.ts', familyId], {
          stdio: 'inherit',
        });
        child.on('close', (code) =>
          code === 0
            ? resolve()
            : reject(new Error(`dump-db exited with code ${code}`)),
        );
        child.on('error', reject);
      })
    : undefined;

  // Inline summary to stdout
  console.log('\n--- Results ---\n');

  const [people, places, events, stories, claims, relationships] =
    await Promise.all([
      dbClient
        .from('people')
        .select('name, aliases, birth_year')
        .eq('family_id', familyId),
      dbClient
        .from('places')
        .select('name, type, city, country')
        .eq('family_id', familyId),
      dbClient
        .from('timeline_events')
        .select('title, event_type, date_text')
        .eq('family_id', familyId),
      dbClient
        .from('stories')
        .select('title, themes, timeframe')
        .eq('family_id', familyId),
      dbClient
        .from('claims')
        .select(
          'subject, claim_type, claim_value, claimed_by, certainty_language',
        )
        .eq('family_id', familyId),
      dbClient.from('relationships').select('*').eq('family_id', familyId),
    ]);

  const section = (label: string, rows: Record<string, unknown>[] | null) => {
    if (!rows?.length) return;
    console.log(`${label} (${rows.length}):`);
    for (const row of rows) {
      console.log(`  ${JSON.stringify(row)}`);
    }
    console.log('');
  };

  section('People', people.data);
  section('Places', places.data);
  section('Events', events.data);
  section('Stories', stories.data);
  section('Claims', claims.data);
  section('Relationships', relationships.data);

  // Interpretation metadata
  const processing = await dbClient
    .from('conversation_event_processing')
    .select('conversation_event_id, processing_metadata')
    .eq('family_id', familyId);

  if (processing.data?.length) {
    console.log('Interpretation:');
    for (const row of processing.data) {
      const meta = row.processing_metadata as Record<string, unknown> | null;
      const interp = meta?.interpretation as
        | Record<string, unknown>
        | undefined;
      if (interp) {
        console.log(`  ${interp.resolvedText}`);
        const ambig = interp.ambiguousReferences as Array<
          Record<string, unknown>
        >;
        if (ambig?.length) {
          for (const ref of ambig) {
            console.log(
              `    "${ref.token}" -> ${ref.selected} (${ref.confidence}) [${(ref.candidates as string[]).join(', ')}]`,
            );
          }
        }
      }
    }
    console.log('');
  }

  console.log(`Family ID: ${familyId}`);

  // Wait for dump-db to finish if it was started
  if (dumpPromise) {
    await dumpPromise;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
