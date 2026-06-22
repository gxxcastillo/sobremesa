import { z } from 'zod';
import type { JsonSchema } from '@sobremesa/ai-provider';

/**
 * Zod schemas for Scribe LLM output.
 * These are the single source of truth - TypeScript types and JSON schema
 * are both derived from these Zod definitions.
 *
 * Note: Schema must stay under Anthropic's 24 optional parameter limit
 * for structured outputs.
 */

const PLACE_TYPES = [
  'city',
  'country',
  'address',
  'region',
  'landmark',
  'neighborhood',
  'building',
] as const;

const EVENT_TYPES = [
  'birth',
  'death',
  'marriage',
  'immigration',
  'migration',
  'business',
  'education',
  'military',
  'residence',
  'travel',
  'celebration',
  'medical',
  'work',
  'other',
] as const;

const RELATIONSHIP_TYPES = [
  'parent',
  'spouse',
  'guardian',
  'godparent',
  'mentor',
  'friend',
  'caregiver',
] as const;

const IMAGE_REFERENCE_TYPES = [
  'describes',
  'identifies_people',
  'provides_context',
  'asks_about',
] as const;

function normalizeVocabularyValue(
  value: unknown,
  aliases: Record<string, string> = {},
): unknown {
  if (typeof value !== 'string') return value;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
  return aliases[normalized] || normalized;
}

const PlaceTypeSchema = z
  .preprocess(
    (value) => normalizeVocabularyValue(value),
    z.enum(PLACE_TYPES).optional(),
  )
  .catch(undefined);

const EventTypeSchema = z
  .preprocess(
    (value) =>
      normalizeVocabularyValue(value, {
        emigration: 'migration',
        moved: 'migration',
        move: 'migration',
        job: 'work',
        employment: 'work',
        school: 'education',
        birthday: 'birth',
      }),
    z.enum(EVENT_TYPES).optional(),
  )
  .catch(undefined);

const RelationshipTypeSchema = z.preprocess(
  (value) =>
    normalizeVocabularyValue(value, {
      mother: 'parent',
      father: 'parent',
      mom: 'parent',
      dad: 'parent',
      husband: 'spouse',
      wife: 'spouse',
      marriage: 'spouse',
      partner: 'spouse',
      godfather: 'godparent',
      godmother: 'godparent',
      padrino: 'godparent',
      madrina: 'godparent',
      best_friend: 'friend',
      family_friend: 'friend',
      caretaker: 'caregiver',
    }),
  z.enum(RELATIONSHIP_TYPES),
);

const ImageReferenceTypeSchema = z
  .preprocess(
    (value) =>
      normalizeVocabularyValue(value, {
        identify_people: 'identifies_people',
        identifies: 'identifies_people',
        people: 'identifies_people',
        context: 'provides_context',
        asks: 'asks_about',
        question: 'asks_about',
      }),
    z.enum(IMAGE_REFERENCE_TYPES),
  )
  .catch('describes');

const PersonSchema = z.object({
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  birth_year: z.number().optional(),
  death_year: z.number().optional(),
});

const PlaceSchema = z.object({
  name: z.string(),
  type: PlaceTypeSchema,
  city: z.string().optional(),
  region: z.string().optional(),
  country: z.string().optional(),
});

const EventSchema = z.object({
  title: z.string(),
  event_type: EventTypeSchema,
  date: z.string().optional(),
  people_involved: z.array(z.string()).default([]),
  place: z.string().optional(),
});

const StorySchema = z.object({
  title: z.string().optional(),
  content: z.string(),
  themes: z.array(z.string()).default([]),
  timeframe: z.string().optional(),
});

const RelationshipSchema = z.object({
  person_a: z.string(),
  person_b: z.string(),
  relationship_type: RelationshipTypeSchema,
});

/**
 * Claim value is a string that may contain JSON.
 * The prompt instructs the LLM to output JSON strings for structured claims:
 * - date: '{"year": 1992, "month": 3, "day": 13, "text": "March 13, 1992"}'
 * - identity: '{"real_name": "Tim", "descriptive_name": "Ralphy\'s friend"}'
 * - simple: 'great' (plain string)
 *
 * The repository will parse JSON strings into objects for database storage.
 * This avoids Anthropic's additionalProperties restriction.
 */
const ClaimValueSchema = z.string();

const ClaimSchema = z.object({
  claim_type: z.enum([
    'date',
    'location',
    'identity',
    'relationship',
    'detail',
  ]),
  subject: z.string(),
  claim_value: ClaimValueSchema,
  certainty_language: z.string().optional(),
  claimed_by: z.string(),
  claimed_by_source: z.enum(['direct', 'attributed', 'hearsay']),
});

const ImageReferenceSchema = z.object({
  image_id: z.string(),
  reference_type: ImageReferenceTypeSchema,
  people_identified: z.array(z.string()).default([]),
  context_provided: z.string().optional(),
});

/**
 * Schema for ambiguous references detected during pronoun resolution.
 */
const AmbiguousReferenceSchema = z.object({
  token: z.string(), // The ambiguous text (e.g., "it", "he")
  candidates: z.array(z.string()), // Possible referents
  selected: z.string(), // Best candidate chosen (conservative pick)
  confidence: z.number(), // 0.0-1.0
});

/**
 * Structured understood_message schema for better interpretation tracking.
 */
const UnderstoodMessageSchema = z.object({
  resolved_text: z.string(), // Full interpretation with pronouns resolved
  ambiguous_references: z.array(AmbiguousReferenceSchema).default([]),
  resolution_confidence: z.enum(['high', 'medium', 'low', 'ambiguous']),
});

export const RawScribeResponseSchema = z.object({
  // Structured interpretation with ambiguity tracking.
  // Metadata-only: degrade to undefined on a malformed value rather than failing
  // the whole parse (which would discard the entire extraction — see response-parser).
  understood_message: UnderstoodMessageSchema.optional().catch(undefined),
  people: z.array(PersonSchema).default([]),
  places: z.array(PlaceSchema).default([]),
  events: z.array(EventSchema).default([]),
  relationships: z.array(RelationshipSchema).default([]),
  claims: z.array(ClaimSchema).default([]),
  stories: z.array(StorySchema).default([]),
  image_references: z.array(ImageReferenceSchema).default([]),
  // Metadata-only: an out-of-list or missing language degrades to 'unknown' rather
  // than failing the whole parse and discarding the extraction.
  detected_language: z
    .enum(['en', 'es', 'pt', 'fr', 'de', 'unknown'])
    .catch('unknown'),
});

/** TypeScript type derived from Zod schema */
export type RawScribeResponse = z.infer<typeof RawScribeResponseSchema>;

/**
 * JSON schema for scribe output.
 * Used with json_schema response format for structured outputs.
 * Generated from Zod schema using Zod v4's native toJSONSchema method.
 */
export const SCRIBE_JSON_SCHEMA: JsonSchema = {
  name: 'scribe_output',
  schema: RawScribeResponseSchema.toJSONSchema() as Record<string, unknown>,
};
