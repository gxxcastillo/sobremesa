#!/usr/bin/env npx tsx
/**
 * Dump current database state to a timestamped JSON snapshot.
 *
 * Usage:
 *   npx tsx scripts/dump-db.ts              # dump most recent family
 *   npx tsx scripts/dump-db.ts <family-id>  # dump specific family
 *   npx tsx scripts/dump-db.ts --all        # dump all families
 *
 * Output: snapshots/<timestamp>-<family-name>.json
 */
import 'dotenv/config';
import { createDatabaseClient } from '../libs/database/src/lib/client.js';
import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = join(__dirname, '..', 'snapshots');

interface FamilySnapshot {
  family: Record<string, unknown>;
  conversationEvents: Record<string, unknown>[];
  people: Record<string, unknown>[];
  places: Record<string, unknown>[];
  events: Record<string, unknown>[];
  stories: Record<string, unknown>[];
  claims: Record<string, unknown>[];
  relationships: Record<string, unknown>[];
  storyPeople: Record<string, unknown>[];
  storyEvents: Record<string, unknown>[];
  storyPlaces: Record<string, unknown>[];
  storyConversationEvents: Record<string, unknown>[];
  eventPeople: Record<string, unknown>[];
  eventPlaces: Record<string, unknown>[];
  processing: Record<string, unknown>[];
}

async function dumpFamily(
  client: ReturnType<typeof createDatabaseClient>,
  family: Record<string, unknown>,
): Promise<FamilySnapshot> {
  const familyId = family.id as string;

  const queries = {
    conversationEvents: client
      .from('conversation_events')
      .select('*')
      .eq('family_id', familyId)
      .order('occurred_at'),
    people: client
      .from('people')
      .select('*')
      .eq('family_id', familyId)
      .order('created_at'),
    places: client
      .from('places')
      .select('*')
      .eq('family_id', familyId)
      .order('created_at'),
    events: client
      .from('events')
      .select('*')
      .eq('family_id', familyId)
      .order('created_at'),
    stories: client
      .from('stories')
      .select('*')
      .eq('family_id', familyId)
      .order('created_at'),
    claims: client
      .from('claims')
      .select('*')
      .eq('family_id', familyId)
      .order('created_at'),
    relationships: client
      .from('relationships')
      .select('*')
      .eq('family_id', familyId)
      .order('created_at'),
    storyPeople: client
      .from('story_people')
      .select('*')
      .eq('family_id', familyId),
    storyEvents: client
      .from('story_events')
      .select('*')
      .eq('family_id', familyId),
    storyPlaces: client
      .from('story_places')
      .select('*')
      .eq('family_id', familyId),
    storyConversationEvents: client
      .from('story_conversation_events')
      .select('*')
      .eq('family_id', familyId),
    eventPeople: client
      .from('event_people')
      .select('*')
      .eq('family_id', familyId),
    eventPlaces: client
      .from('event_places')
      .select('*')
      .eq('family_id', familyId),
    processing: client
      .from('conversation_event_processing')
      .select('*')
      .eq('family_id', familyId)
      .order('processed_at'),
  };

  const results = await Promise.all(
    Object.entries(queries).map(async ([key, query]) => {
      const { data, error } = await query;
      if (error) {
        console.error(`  Warning: failed to query ${key}: ${error.message}`);
        return [key, []];
      }
      return [key, data || []];
    }),
  );

  const snapshot = Object.fromEntries(results) as unknown as Omit<
    FamilySnapshot,
    'family'
  >;

  return { family, ...snapshot };
}

async function main() {
  const client = createDatabaseClient({
    url: process.env['SUPABASE_URL']!,
    anonKey: process.env['SUPABASE_ANON_KEY']!,
    serviceRoleKey: process.env['SUPABASE_SERVICE_ROLE_KEY'],
  });

  const arg = process.argv[2];

  // Resolve which families to dump
  let families: Record<string, unknown>[];

  if (arg === '--all') {
    const { data, error } = await client
      .from('families')
      .select('*')
      .order('created_at');
    if (error) throw new Error(`Failed to fetch families: ${error.message}`);
    families = data || [];
  } else if (arg) {
    const { data, error } = await client
      .from('families')
      .select('*')
      .eq('id', arg)
      .single();
    if (error)
      throw new Error(`Failed to fetch family ${arg}: ${error.message}`);
    families = [data];
  } else {
    const { data, error } = await client
      .from('families')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(`Failed to fetch families: ${error.message}`);
    families = data || [];
  }

  if (families.length === 0) {
    console.log('No families found.');
    return;
  }

  mkdirSync(SNAPSHOT_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  for (const family of families) {
    const familyName = (family.name as string)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+$/, '');

    console.log(`Dumping "${family.name}"...`);
    const snapshot = await dumpFamily(client, family);

    const filename = `${timestamp}-${familyName}.json`;
    const filepath = join(SNAPSHOT_DIR, filename);
    writeFileSync(filepath, JSON.stringify(snapshot, null, 2) + '\n');

    const counts = [
      `${snapshot.conversationEvents.length} messages`,
      `${snapshot.people.length} people`,
      `${snapshot.places.length} places`,
      `${snapshot.events.length} events`,
      `${snapshot.stories.length} stories`,
      `${snapshot.claims.length} claims`,
      `${snapshot.relationships.length} relationships`,
    ].join(', ');

    console.log(`  → ${filepath}`);
    console.log(`  ${counts}`);
  }
}

main().catch(console.error);
