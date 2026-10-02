#!/usr/bin/env bun
/**
 * Live-DB integration tests for extraction-hardening F: a source message
 * contributes to stories at most once, atomically. Drives the real
 * `persist_story_contribution` function and a real `RegistrarAgent.persist`
 * (no LLM on that path) against a running local Supabase instance, because
 * the guarantees -- one transaction, the per-message advisory lock, the
 * family-scoped row lock -- only exist in Postgres, not in a mock.
 *
 * Each scenario creates its own throwaway family and deletes it in `finally`.
 * Manual only -- not part of test:all/CI, like the other tests/ scripts (no
 * CI infra spins up a local Supabase instance yet). Requires
 * `bun nx run db:start` first.
 *
 * Run with: bun tests/test-story-contribution.ts
 */
import 'dotenv/config';
import type { DatabaseClient, StoryContribution } from '@sobremesa/database';
import { RegistrarAgent } from '@sobremesa/agents-registrar';
import type { ScribeDomainModel } from '@sobremesa/shared-types';
import {
  createLiveDbClient,
  randomSuffix,
  runScenarios,
  type ScenarioResult,
} from './live-db-test-utils.js';

const STORY = {
  title: 'The drive to Havana',
  content: 'Maria remembered the long drive to Havana.',
  themes: ['travel', 'family'],
};

async function main(): Promise<void> {
  const allowRemoteDb = process.argv.includes('--allow-remote-db');
  const client = createLiveDbClient('Story contribution tests', allowRemoteDb);

  await runScenarios(
    [
      {
        name: 'retrying a create writes nothing',
        run: () => withFamily(client, (f) => retryCreate(client, f)),
      },
      {
        name: 'append unions themes, keeps timeframe, retry writes nothing',
        run: () => withFamily(client, (f) => appendAndRetry(client, f)),
      },
      {
        name: 'concurrent attempts for one message apply once',
        run: () => withFamily(client, (f) => concurrentAttempts(client, f)),
      },
      {
        name: 'an append target from another family is refused',
        run: () => crossFamilyTarget(client),
      },
      {
        name: 'Registrar.persist twice is a no-op the second time',
        run: () => withFamily(client, (f) => persistTwice(client, f)),
      },
      {
        name: 'Registrar.persist repairs links lost to a crash',
        run: () => withFamily(client, (f) => persistRepairsLinks(client, f)),
      },
    ],
    {
      allPassed: 'All story contribution scenarios passed.',
      someFailed: (count) => `${count} story contribution scenario(s) failed.`,
    },
  );
}

// --- scenarios ---------------------------------------------------------------

async function retryCreate(
  client: DatabaseClient,
  familyId: string,
): Promise<ScenarioResult> {
  const name = 'retrying a create writes nothing';
  const eventId = await insertEvent(client, familyId, STORY.content);

  const first = await contribute(client, familyId, eventId, null, STORY);
  const second = await contribute(client, familyId, eventId, null, STORY);
  const stories = await storiesFor(client, familyId);

  const ok =
    first.outcome === 'created' &&
    second.outcome === 'already_applied' &&
    second.storyId === first.storyId &&
    stories.length === 1 &&
    stories[0].content_original === STORY.content &&
    (await linkCount(client, familyId, eventId)) === 1;
  return {
    name,
    passed: ok,
    detail: ok
      ? 'created once; the retry reported already_applied and wrote nothing'
      : `outcomes ${first.outcome}/${second.outcome}, ${stories.length} stories`,
  };
}

async function appendAndRetry(
  client: DatabaseClient,
  familyId: string,
): Promise<ScenarioResult> {
  const name = 'append unions themes, keeps timeframe, retry writes nothing';
  const firstEvent = await insertEvent(client, familyId, STORY.content);
  const created = await contribute(client, familyId, firstEvent, null, {
    ...STORY,
    timeframe: '1950s',
  });

  const secondEvent = await insertEvent(client, familyId, 'It took two days.');
  const more = {
    content: 'It took two days.',
    themes: ['family', 'cars'],
    timeframe: '1960s',
  };
  const appended = await contribute(
    client,
    familyId,
    secondEvent,
    created.storyId,
    more,
  );
  const retried = await contribute(
    client,
    familyId,
    secondEvent,
    created.storyId,
    more,
  );

  const [story] = await storiesFor(client, familyId);
  const expectedContent = `${STORY.content}\n\nIt took two days.`;
  const ok =
    appended.outcome === 'appended' &&
    retried.outcome === 'already_applied' &&
    story.content_original === expectedContent &&
    JSON.stringify(story.themes) ===
      JSON.stringify(['travel', 'family', 'cars']) &&
    story.timeframe === '1950s';
  return {
    name,
    passed: ok,
    detail: ok
      ? 'appended once; themes [travel, family, cars]; timeframe kept 1950s'
      : `outcomes ${appended.outcome}/${retried.outcome}; content ${JSON.stringify(story.content_original)}; themes ${JSON.stringify(story.themes)}; timeframe ${story.timeframe}`,
  };
}

// Smoke test only: over HTTP the race window is too small to hit, so this
// also passes with the advisory lock removed. The lock itself was verified
// with two psql sessions (one holding its transaction open across the call):
// with the lock the second gets 'already_applied'; without it, two stories.
async function concurrentAttempts(
  client: DatabaseClient,
  familyId: string,
): Promise<ScenarioResult> {
  const name = 'concurrent attempts for one message apply once';
  const eventId = await insertEvent(client, familyId, STORY.content);

  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      contribute(client, familyId, eventId, null, STORY),
    ),
  );
  const created = results.filter((r) => r.outcome === 'created');
  const stories = await storiesFor(client, familyId);

  const ok =
    created.length === 1 &&
    stories.length === 1 &&
    (await linkCount(client, familyId, eventId)) === 1;
  return {
    name,
    passed: ok,
    detail: ok
      ? '5 parallel attempts: 1 created, 4 already_applied, 1 story'
      : `${created.length} created, ${stories.length} stories`,
  };
}

async function crossFamilyTarget(
  client: DatabaseClient,
): Promise<ScenarioResult> {
  const name = 'an append target from another family is refused';
  return withFamily(client, (familyA) =>
    withFamily(client, async (familyB) => {
      const eventA = await insertEvent(client, familyA, STORY.content);
      const storyA = await contribute(client, familyA, eventA, null, STORY);

      const eventB = await insertEvent(client, familyB, 'Something else.');
      let refused = false;
      try {
        await contribute(client, familyB, eventB, storyA.storyId, {
          content: 'Something else.',
          themes: [],
        });
      } catch (err) {
        refused = String(err).includes('not found');
      }

      const [story] = await storiesFor(client, familyA);
      const ok =
        refused &&
        story.content_original === STORY.content &&
        (await linkCount(client, familyB, eventB)) === 0;
      return {
        name,
        passed: ok,
        detail: ok
          ? "family B could not append to family A's story; nothing written"
          : `refused=${refused}, A content ${JSON.stringify(story.content_original)}`,
      };
    }),
  );
}

async function persistTwice(
  client: DatabaseClient,
  familyId: string,
): Promise<ScenarioResult> {
  const name = 'Registrar.persist twice is a no-op the second time';
  const text =
    'Maria remembered the long drive to Havana. She was born in 1931.';
  const eventId = await insertEvent(client, familyId, text);
  const registrar = new RegistrarAgent({ dbClient: client });
  const model = domainModel(familyId, eventId);

  await registrar.persist(model, familyId);
  const before = await snapshot(client, familyId);
  await registrar.persist(model, familyId);
  const after = await snapshot(client, familyId);

  const ok =
    before.stories === 1 &&
    before.claims > 0 &&
    JSON.stringify(before) === JSON.stringify(after);
  return {
    name,
    passed: ok,
    detail: ok
      ? `second run changed nothing (${JSON.stringify(after)})`
      : `before ${JSON.stringify(before)} vs after ${JSON.stringify(after)}`,
  };
}

async function persistRepairsLinks(
  client: DatabaseClient,
  familyId: string,
): Promise<ScenarioResult> {
  const name = 'Registrar.persist repairs links lost to a crash';
  const text =
    'Maria remembered the long drive to Havana. She was born in 1931.';
  const eventId = await insertEvent(client, familyId, text);
  const registrar = new RegistrarAgent({ dbClient: client });
  const model = domainModel(familyId, eventId);

  await registrar.persist(model, familyId);
  const complete = await snapshot(client, familyId);

  // Simulate a crash after the story committed but before its entity links
  // were written: remove the links the first attempt made.
  for (const table of ['story_people', 'story_places']) {
    const { error } = await client
      .from(table)
      .delete()
      .eq('family_id', familyId);
    if (error) throw new Error(`Failed to clear ${table}: ${error.message}`);
  }

  await registrar.persist(model, familyId);
  const repaired = await snapshot(client, familyId);

  const ok =
    complete.storyPeople > 0 &&
    complete.storyPlaces > 0 &&
    JSON.stringify(complete) === JSON.stringify(repaired);
  return {
    name,
    passed: ok,
    detail: ok
      ? `links restored, story text unchanged (${JSON.stringify(repaired)})`
      : `complete ${JSON.stringify(complete)} vs repaired ${JSON.stringify(repaired)}`,
  };
}

// --- fixtures ----------------------------------------------------------------

function domainModel(familyId: string, eventId: string): ScribeDomainModel {
  return {
    conversationEventId: eventId,
    familyId,
    processedAt: new Date(),
    people: [
      { name: 'Maria', aliases: [], confidence: 'high', birthYear: 1931 },
    ],
    places: [{ name: 'Havana', confidence: 'high' }],
    events: [],
    relationships: [],
    claims: [
      {
        claimType: 'date',
        subject: 'Maria',
        claimValue: { birthYear: 1931 },
        evidence: 'She was born in 1931',
        confidence: 'high',
        claimedBySource: 'direct',
        referencedPeople: ['Maria'],
      },
    ],
    story: STORY,
    imageReferences: [],
    detectedLanguage: 'en',
  } as unknown as ScribeDomainModel;
}

async function withFamily(
  client: DatabaseClient,
  run: (familyId: string) => Promise<ScenarioResult>,
): Promise<ScenarioResult> {
  const { data, error } = await client
    .from('families')
    .insert({
      name: 'Story Contribution Test',
      chat_source: 'telegram',
      chat_id: `story-contribution-${randomSuffix()}`,
      config: {},
    })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(`Failed to create test family: ${error?.message}`);
  }
  const familyId = String(data.id);
  try {
    return await run(familyId);
  } finally {
    await client.rpc('delete_family_cascade', { p_family_id: familyId });
  }
}

async function insertEvent(
  client: DatabaseClient,
  familyId: string,
  text: string,
): Promise<string> {
  const now = new Date().toISOString();
  const { data, error } = await client
    .from('conversation_events')
    .insert({
      family_id: familyId,
      source: 'telegram',
      conversation_id: 'story-contribution-chat',
      external_event_id: `story-contribution-${randomSuffix()}`,
      actor_external_id: 'story-contribution-sender',
      actor_display_name: 'Abuela',
      event_type: 'message',
      content_original: text,
      language_original: 'en',
      metadata: {},
      source_payload: {},
      occurred_at: now,
      ingested_at: now,
    })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(`Failed to insert test event: ${error?.message}`);
  }
  return String(data.id);
}

/** Calls the function directly with an explicit target, bypassing matching. */
async function contribute(
  client: DatabaseClient,
  familyId: string,
  eventId: string,
  targetStoryId: string | null,
  story: {
    title?: string;
    content: string;
    themes: string[];
    timeframe?: string;
  },
): Promise<StoryContribution> {
  const { data, error } = await client
    .rpc('persist_story_contribution', {
      p_family_id: familyId,
      p_conversation_event_id: eventId,
      p_target_story_id: targetStoryId,
      p_title: story.title ?? null,
      p_content: story.content,
      p_content_language: 'en',
      p_themes: story.themes,
      p_timeframe: story.timeframe ?? null,
      p_shared_by: 'Abuela',
      p_extraction_version: 'story-contribution-test',
    })
    .single<{ story_id: string; outcome: StoryContribution['outcome'] }>();
  if (error) throw new Error(error.message);
  return { storyId: data.story_id, outcome: data.outcome };
}

async function storiesFor(
  client: DatabaseClient,
  familyId: string,
): Promise<
  Array<{
    content_original: string;
    themes: string[];
    timeframe: string | null;
  }>
> {
  const { data, error } = await client
    .from('stories')
    .select('content_original, themes, timeframe')
    .eq('family_id', familyId);
  if (error) throw new Error(`Failed to read stories: ${error.message}`);
  return data ?? [];
}

async function linkCount(
  client: DatabaseClient,
  familyId: string,
  eventId: string,
): Promise<number> {
  const { count, error } = await client
    .from('story_conversation_events')
    .select('*', { count: 'exact', head: true })
    .eq('family_id', familyId)
    .eq('conversation_event_id', eventId);
  if (error) throw new Error(`Failed to count links: ${error.message}`);
  return count ?? 0;
}

async function snapshot(client: DatabaseClient, familyId: string) {
  const count = async (table: string) => {
    const { count: n, error } = await client
      .from(table)
      .select('*', { count: 'exact', head: true })
      .eq('family_id', familyId);
    if (error) throw new Error(`Failed to count ${table}: ${error.message}`);
    return n ?? 0;
  };
  const stories = await storiesFor(client, familyId);
  return {
    people: await count('people'),
    places: await count('places'),
    claims: await count('claims'),
    stories: stories.length,
    storyContent: stories.map((s) => s.content_original).join('|'),
    storyPeople: await count('story_people'),
    storyPlaces: await count('story_places'),
    storySources: await count('story_conversation_events'),
  };
}

main().catch((err) => {
  console.error('Story contribution tests failed with error:', err);
  process.exit(1);
});
