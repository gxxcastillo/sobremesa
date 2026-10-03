import { describe, it, expect } from 'vitest';
import { parseScribeResponse, ScribeParseError } from './response-parser';

const EVENT_ID = 'event-1';
const FAMILY_ID = 'family-1';

const parse = (raw: string) => parseScribeResponse(raw, EVENT_ID, FAMILY_ID);

describe('parseScribeResponse — atomic & recoverable (spec §3.3)', () => {
  describe('fails loud (never silently drops a non-empty extraction)', () => {
    it('throws ScribeParseError on unparseable JSON', () => {
      expect(() => parse('this is not json at all')).toThrow(ScribeParseError);
    });

    it('throws ScribeParseError on truncated JSON', () => {
      expect(() => parse('{"people": [{"name": "Maria"')).toThrow(
        ScribeParseError,
      );
    });

    it('throws ScribeParseError when entity data is malformed', () => {
      // A claim that is well-formed except for an out-of-enum claim_type.
      // Entity arrays have NO .catch(), so this must surface as a hard failure
      // rather than being silently dropped.
      const raw = JSON.stringify({
        claims: [
          {
            claim_type: 'not-a-real-type',
            subject: 'Maria',
            claim_value: 'born in 1950',
            evidence: 'born in 1950',
            claimed_by_source: 'direct',
          },
        ],
      });
      expect(() => parse(raw)).toThrow(ScribeParseError);
    });

    it('throws ScribeParseError when a claim has no evidence span (#3)', () => {
      // evidence is required in the LLM contract: without it the Registrar
      // cannot ground the claim, so the parse fails loud rather than
      // persisting an ungroundable claim.
      const raw = JSON.stringify({
        claims: [
          {
            claim_type: 'detail',
            subject: 'Maria',
            claim_value: 'loved fishing',
            claimed_by_source: 'direct',
          },
        ],
      });
      expect(() => parse(raw)).toThrow(ScribeParseError);
    });

    it('attaches the conversationEventId to the thrown error', () => {
      try {
        parse('nonsense');
        throw new Error('expected parse to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ScribeParseError);
        expect((err as ScribeParseError).conversationEventId).toBe(EVENT_ID);
      }
    });
  });

  describe('degrades malformed metadata instead of failing the whole parse', () => {
    it('keeps the extraction when detected_language is out-of-list', () => {
      const raw = JSON.stringify({
        detected_language: 'it', // not in the enum
        people: [{ name: 'Maria' }],
      });
      const model = parse(raw);
      expect(model.people).toHaveLength(1);
      expect(model.people[0].name).toBe('Maria');
      expect(model.detectedLanguage).toBe('unknown');
    });

    it('keeps the extraction when understood_message is malformed', () => {
      const raw = JSON.stringify({
        understood_message: 'should have been an object',
        claims: [
          {
            claim_type: 'detail',
            subject: 'Maria',
            claim_value: 'loved fishing',
            evidence: 'she loved fishing',
            claimed_by_source: 'direct',
          },
        ],
      });
      const model = parse(raw);
      expect(model.claims).toHaveLength(1);
      expect(model.interpretation).toBeUndefined();
    });
  });

  describe('legitimately-empty extraction is NOT a failure', () => {
    it('returns an empty model for an empty object (no throw)', () => {
      const model = parse('{}');
      expect(model.people).toEqual([]);
      expect(model.claims).toEqual([]);
      expect(model.story).toBeUndefined();
      expect(model.detectedLanguage).toBe('unknown');
    });
  });

  describe('happy path', () => {
    it('parses people and claims from a well-formed response', () => {
      const raw = JSON.stringify({
        detected_language: 'es',
        people: [{ name: 'Maria' }],
        claims: [
          {
            claim_type: 'date',
            subject: "Maria's birth",
            claim_value: '1950',
            evidence: 'Maria was born in 1950',
            claimed_by_source: 'direct',
          },
        ],
      });
      const model = parse(raw);
      expect(model.people[0].name).toBe('Maria');
      expect(model.claims[0].claimType).toBe('date');
      expect(model.claims[0].evidence).toBe('Maria was born in 1950');
      expect(model.detectedLanguage).toBe('es');
    });

    it('maps attributed_to onto claims and leaves it undefined when absent (#2)', () => {
      const raw = JSON.stringify({
        claims: [
          {
            claim_type: 'date',
            subject: 'Grandpa Ernesto',
            claim_value: '1939',
            evidence: 'Mom always said Grandpa was born in 1939',
            claimed_by_source: 'hearsay',
            attributed_to: 'Mom',
          },
          {
            claim_type: 'detail',
            subject: 'Maria',
            claim_value: 'loved fishing',
            evidence: 'Maria loved fishing',
            claimed_by_source: 'direct',
          },
        ],
      });

      const model = parse(raw);

      expect(model.claims[0].attributedTo).toBe('Mom');
      expect(model.claims[1].attributedTo).toBeUndefined();
      expect((model.claims[0] as Record<string, unknown>)['claimedBy']).toBe(
        undefined,
      );
    });

    it('extracts dateYear from structured event date objects (#9)', () => {
      const raw = JSON.stringify({
        events: [
          {
            title: 'Summer trip',
            date: { year: 92, text: 'summer of 92' },
          },
        ],
      });

      const model = parse(raw);

      expect(model.events[0].dateText).toBe('summer of 92');
      expect(model.events[0].dateYear).toBe(1992);
    });

    it('coerces numeric string years in structured event date objects (#9)', () => {
      const raw = JSON.stringify({
        events: [
          {
            title: 'Summer trip',
            date: { year: '1992', text: 'summer 1992' },
          },
        ],
      });

      const model = parse(raw);

      expect(model.events[0].dateText).toBe('summer 1992');
      expect(model.events[0].dateYear).toBe(1992);
    });

    it('extracts dateYear from JSON-string event dates (#9)', () => {
      const raw = JSON.stringify({
        events: [
          {
            title: 'Birthday party',
            date: JSON.stringify({ year: 2005, text: 'May 2005' }),
          },
        ],
      });

      const model = parse(raw);

      expect(model.events[0].dateText).toBe('May 2005');
      expect(model.events[0].dateYear).toBe(2005);
    });

    it('maps referenced_people and referenced_places onto claims (#10)', () => {
      const raw = JSON.stringify({
        claims: [
          {
            claim_type: 'location',
            subject: 'la boda de María',
            claim_value: 'Buenos Aires',
            evidence: 'la boda de María fue en Buenos Aires',
            claimed_by_source: 'direct',
            referenced_people: ['María'],
            referenced_places: ['Buenos Aires'],
          },
        ],
      });

      const model = parse(raw);

      expect(model.claims[0].referencedPeople).toEqual(['María']);
      expect(model.claims[0].referencedPlaces).toEqual(['Buenos Aires']);
    });

    it('normalizes controlled vocabulary fields (#8)', () => {
      const raw = JSON.stringify({
        places: [{ name: 'Buenos Aires', type: 'City' }],
        events: [{ title: 'Moved to Miami', event_type: 'emigration' }],
        relationships: [
          {
            person_a: 'Maria',
            person_b: 'Roberto',
            relationship_type: 'wife',
          },
        ],
        image_references: [
          {
            image_id: 'img-1',
            reference_type: 'context',
          },
        ],
      });

      const model = parse(raw);

      expect(model.places[0].type).toBe('city');
      expect(model.events[0].eventType).toBe('migration');
      expect(model.relationships[0].relationshipType).toBe('spouse');
      expect(model.imageReferences[0].referenceType).toBe('provides_context');
    });

    it('drops unknown optional place/event types without dropping the extraction (#8)', () => {
      const raw = JSON.stringify({
        places: [{ name: 'Somewhere', type: 'planet' }],
        events: [{ title: 'A specific memory', event_type: 'legend' }],
      });

      const model = parse(raw);

      expect(model.places[0].name).toBe('Somewhere');
      expect(model.places[0].type).toBeUndefined();
      expect(model.events[0].title).toBe('A specific memory');
      expect(model.events[0].eventType).toBeUndefined();
    });

    it('throws on unknown relationship_type because relationship data is structural (#8)', () => {
      const raw = JSON.stringify({
        relationships: [
          {
            person_a: 'Maria',
            person_b: 'Roberto',
            relationship_type: 'cousin',
          },
        ],
      });

      expect(() => parse(raw)).toThrow(ScribeParseError);
    });

    it('normalizes explicit null on optional fields instead of failing the parse (#9)', () => {
      // Reproduces the two real messages that exhausted all retries: Scribe
      // emits an explicit JSON `null` for a field it has no value for
      // (birth/death years, place, date, certainty_language, attributed_to)
      // rather than omitting the key.
      const raw = JSON.stringify({
        people: [{ name: 'Angelita', birth_year: 1918, death_year: null }],
        places: [
          { name: 'Somewhere', city: null, region: null, country: null },
        ],
        events: [
          {
            title: "Angelita's birthday",
            date: { year: null, month: 7, day: 3, text: null },
            place: null,
          },
          { title: 'Undated event', date: null },
        ],
        stories: [{ content: 'A long story', title: null, timeframe: null }],
        claims: [
          {
            claim_type: 'detail',
            subject: 'Angelita',
            claim_value: 'Family matriarch',
            evidence: 'Felicidades a nuestra Mamalita',
            claimed_by_source: 'direct',
            certainty_language: null,
            attributed_to: null,
          },
        ],
        image_references: [
          {
            image_id: 'img-1',
            reference_type: 'describes',
            context_provided: null,
          },
        ],
      });

      const model = parse(raw);

      expect(model.people[0].deathYear).toBeUndefined();
      expect(model.places[0].city).toBeUndefined();
      expect(model.places[0].region).toBeUndefined();
      expect(model.places[0].country).toBeUndefined();
      expect(model.events[0].dateYear).toBeUndefined();
      expect(model.events[0].placeName).toBeUndefined();
      expect(model.events[1].dateText).toBeUndefined();
      expect(model.story?.title).toBeUndefined();
      expect(model.story?.timeframe).toBeUndefined();
      expect(model.claims[0].certaintyLanguage).toBeUndefined();
      expect(model.claims[0].attributedTo).toBeUndefined();
      expect(model.imageReferences[0].contextProvided).toBeUndefined();
    });

    it('maps from_context on people, places, events and stories; null or junk means absent (provenance #4)', () => {
      const model = parse(
        JSON.stringify({
          people: [
            { name: 'Rosa', from_context: true },
            { name: 'Ernesto', from_context: null },
            { name: 'Lucia' },
          ],
          places: [{ name: 'Oaxaca', from_context: true }, { name: 'Lima' }],
          events: [
            { title: 'Wedding', from_context: true },
            { title: 'Funeral', from_context: 'yes' },
          ],
          stories: [{ content: 'ctx', from_context: true }],
        }),
      );

      expect(model.people.map((p) => p.fromContext)).toEqual([
        true,
        undefined,
        undefined,
      ]);
      expect(model.places.map((p) => p.fromContext)).toEqual([true, undefined]);
      // A malformed flag degrades to absent rather than failing the parse.
      expect(model.events.map((e) => e.fromContext)).toEqual([true, undefined]);
      expect(model.story?.fromContext).toBe(true);
    });

    it('prefers a current-message story over a from_context one (provenance #4)', () => {
      const model = parse(
        JSON.stringify({
          stories: [
            { content: 'from the context', from_context: true },
            { content: 'asserted now' },
          ],
        }),
      );

      expect(model.story?.content).toBe('asserted now');
      expect(model.story?.fromContext).toBeUndefined();
    });
  });
});
