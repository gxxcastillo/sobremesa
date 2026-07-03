import type { DatabaseClient } from '@sobremesa/database';

export interface StableConversationEvent {
  sequenceNumber: number;
  sender: string;
  content: string;
}

export interface StablePerson {
  name: string;
  aliases: string[];
  birthYear?: number;
  deathYear?: number;
}

export interface StablePlace {
  name: string;
  type?: string;
  city?: string;
  region?: string;
  country?: string;
}

export interface StableEvent {
  title: string;
  eventType?: string;
  dateText?: string;
  dateYear?: number;
}

export interface StableStory {
  title?: string;
  contentOriginal: string;
  themes: string[];
  timeframe?: string;
}

export interface StableClaim {
  subject: string;
  claimType: string;
  claimValue: Record<string, unknown>;
  claimedBy: string;
  claimedBySource: string;
}

export interface StableRelationship {
  personA: string;
  personB: string;
  relationshipType: string;
}

export interface StableLinkCounts {
  claimEntities: number;
  claimRelationships: number;
  storyPeople: number;
  storyPlaces: number;
  storyEvents: number;
  storyConversationEvents: number;
  eventPeople: number;
  eventPlaces: number;
}

export interface StablePipelineSnapshot {
  conversationEvents: StableConversationEvent[];
  people: StablePerson[];
  places: StablePlace[];
  events: StableEvent[];
  stories: StableStory[];
  claims: StableClaim[];
  relationships: StableRelationship[];
  linkCounts: StableLinkCounts;
}

export interface SnapshotComparison {
  passed: boolean;
  mismatches: string[];
}

const SYMMETRIC_RELATIONSHIPS = new Set(['spouse', 'friend']);

export async function readStablePipelineSnapshot(
  client: DatabaseClient,
  familyId: string,
): Promise<StablePipelineSnapshot> {
  const [
    conversationEvents,
    people,
    places,
    events,
    stories,
    claims,
    relationships,
    linkCounts,
  ] = await Promise.all([
    selectFamilyRows(client, 'conversation_events', familyId),
    selectFamilyRows(client, 'people', familyId),
    selectFamilyRows(client, 'places', familyId),
    selectFamilyRows(client, 'events', familyId),
    selectFamilyRows(client, 'stories', familyId),
    selectFamilyRows(client, 'claims', familyId),
    selectFamilyRows(client, 'relationships', familyId),
    readLinkCounts(client, familyId),
  ]);

  const personNameById = new Map(
    people.map((person) => [String(person['id']), String(person['name'])]),
  );

  return {
    conversationEvents: sortRecords(
      conversationEvents.map((event) => ({
        sequenceNumber: Number(event['sequence_number']),
        sender:
          stringValue(event['actor_display_name']) ||
          stringValue(event['actor_username']) ||
          'Unknown',
        content: stringValue(event['content_original']),
      })),
    ),
    people: sortRecords(
      people.map((person) => ({
        name: stringValue(person['name']),
        aliases: stringArray(person['aliases']).sort(),
        birthYear: optionalNumber(person['birth_year']),
        deathYear: optionalNumber(person['death_year']),
      })),
    ),
    places: sortRecords(
      places.map((place) => ({
        name: stringValue(place['name']),
        type: optionalString(place['type']),
        city: optionalString(place['city']),
        region: optionalString(place['region']),
        country: optionalString(place['country']),
      })),
    ),
    events: sortRecords(
      events.map((event) => ({
        title: stringValue(event['title']),
        eventType: optionalString(event['event_type']),
        dateText: optionalString(event['date_text']),
        dateYear: optionalNumber(event['date_year']),
      })),
    ),
    stories: sortRecords(
      stories.map((story) => ({
        title: optionalString(story['title']),
        contentOriginal: stringValue(story['content_original']),
        themes: stringArray(story['themes']).sort(),
        timeframe: optionalString(story['timeframe']),
      })),
    ),
    claims: sortRecords(
      claims.map((claim) => ({
        subject: stringValue(claim['subject']),
        claimType: stringValue(claim['claim_type']),
        claimValue: objectValue(claim['claim_value']),
        claimedBy: stringValue(claim['claimed_by']),
        claimedBySource: stringValue(claim['claimed_by_source']),
      })),
    ),
    relationships: sortRecords(
      relationships.map((relationship) =>
        normalizeRelationshipSnapshot({
          personA:
            personNameById.get(String(relationship['person_a_id'])) ??
            'Unknown',
          personB:
            personNameById.get(String(relationship['person_b_id'])) ??
            'Unknown',
          relationshipType: stringValue(relationship['relationship_type']),
        }),
      ),
    ),
    linkCounts,
  };
}

export function compareStableSnapshots(
  actual: StablePipelineSnapshot,
  expected: StablePipelineSnapshot,
): SnapshotComparison {
  const normalizedActual = normalizeStablePipelineSnapshot(actual);
  const normalizedExpected = normalizeStablePipelineSnapshot(expected);
  const mismatches: string[] = [];
  compareSection(
    'conversationEvents',
    normalizedActual,
    normalizedExpected,
    mismatches,
  );
  compareSection('people', normalizedActual, normalizedExpected, mismatches);
  compareSection('places', normalizedActual, normalizedExpected, mismatches);
  compareSection('events', normalizedActual, normalizedExpected, mismatches);
  compareSection('stories', normalizedActual, normalizedExpected, mismatches);
  compareSection('claims', normalizedActual, normalizedExpected, mismatches);
  compareSection(
    'relationships',
    normalizedActual,
    normalizedExpected,
    mismatches,
  );
  compareSection(
    'linkCounts',
    normalizedActual,
    normalizedExpected,
    mismatches,
  );

  return {
    passed: mismatches.length === 0,
    mismatches,
  };
}

export function normalizeStablePipelineSnapshot(
  snapshot: StablePipelineSnapshot,
): StablePipelineSnapshot {
  return {
    conversationEvents: sortRecords(snapshot.conversationEvents),
    people: sortRecords(
      snapshot.people.map((person) => ({
        ...person,
        aliases: [...person.aliases].sort(),
      })),
    ),
    places: sortRecords(snapshot.places),
    events: sortRecords(snapshot.events),
    stories: sortRecords(
      snapshot.stories.map((story) => ({
        ...story,
        themes: [...story.themes].sort(),
      })),
    ),
    claims: sortRecords(snapshot.claims),
    relationships: sortRecords(
      snapshot.relationships.map(normalizeRelationshipSnapshot),
    ),
    linkCounts: snapshot.linkCounts,
  };
}

function compareSection(
  section: keyof StablePipelineSnapshot,
  actual: StablePipelineSnapshot,
  expected: StablePipelineSnapshot,
  mismatches: string[],
): void {
  const actualJson = stableStringify(actual[section]);
  const expectedJson = stableStringify(expected[section]);
  if (actualJson !== expectedJson) {
    mismatches.push(
      `${section} mismatch\nexpected ${expectedJson}\nactual   ${actualJson}`,
    );
  }
}

async function selectFamilyRows(
  client: DatabaseClient,
  table: string,
  familyId: string,
): Promise<Record<string, unknown>[]> {
  const { data, error } = await client
    .from(table)
    .select('*')
    .eq('family_id', familyId);

  if (error) {
    throw new Error(`Failed to query ${table}: ${error.message}`);
  }

  return (data ?? []) as Record<string, unknown>[];
}

async function readLinkCounts(
  client: DatabaseClient,
  familyId: string,
): Promise<StableLinkCounts> {
  const tables = [
    ['claimEntities', 'claim_entities'],
    ['claimRelationships', 'claim_relationships'],
    ['storyPeople', 'story_people'],
    ['storyPlaces', 'story_places'],
    ['storyEvents', 'story_events'],
    ['storyConversationEvents', 'story_conversation_events'],
    ['eventPeople', 'event_people'],
    ['eventPlaces', 'event_places'],
  ] as const;

  const entries = await Promise.all(
    tables.map(async ([key, table]) => {
      const { count, error } = await client
        .from(table)
        .select('*', { count: 'exact', head: true })
        .eq('family_id', familyId);

      if (error) {
        throw new Error(`Failed to count ${table}: ${error.message}`);
      }

      return [key, count ?? 0] as const;
    }),
  );

  return Object.fromEntries(entries) as unknown as StableLinkCounts;
}

function normalizeRelationshipSnapshot(
  relationship: StableRelationship,
): StableRelationship {
  if (!SYMMETRIC_RELATIONSHIPS.has(relationship.relationshipType)) {
    return relationship;
  }

  const [personA, personB] = [
    relationship.personA,
    relationship.personB,
  ].sort();
  return {
    ...relationship,
    personA,
    personB,
  };
}

function sortRecords<T>(records: T[]): T[] {
  return [...records].sort((a, b) =>
    stableStringify(a).localeCompare(stableStringify(b)),
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortObject(value));
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, sortObject(entryValue)]),
  );
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : { value };
}
