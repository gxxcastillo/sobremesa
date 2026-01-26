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

const PersonSchema = z.object({
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  birth_year: z.number().optional(),
  death_year: z.number().optional(),
});

const PlaceSchema = z.object({
  name: z.string(),
  type: z.string().optional(),
  city: z.string().optional(),
  region: z.string().optional(),
  country: z.string().optional(),
});

const EventSchema = z.object({
  title: z.string(),
  event_type: z.string().optional(),
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
  relationship_type: z.string(),
});

/**
 * Claim types:
 * - Singular (one value per subject, can conflict): date, location, identity, relationship
 * - Additive (multiple per subject, never conflict): detail
 */
const ClaimSchema = z.object({
  claim_type: z.enum([
    'date',
    'location',
    'identity',
    'relationship',
    'detail',
  ]),
  subject: z.string(),
  claim_value: z.string(),
  certainty_language: z.string().optional(), // "definitely", "I think", etc.
  claimed_by: z.string(), // sender name or attributed person
  claimed_by_source: z.enum(['direct', 'attributed', 'hearsay']),
});

const ImageReferenceSchema = z.object({
  image_id: z.string(),
  reference_type: z.string(),
  people_identified: z.array(z.string()).default([]),
  context_provided: z.string().optional(),
});

export const RawScribeResponseSchema = z.object({
  people: z.array(PersonSchema).default([]),
  places: z.array(PlaceSchema).default([]),
  events: z.array(EventSchema).default([]),
  relationships: z.array(RelationshipSchema).default([]),
  claims: z.array(ClaimSchema).default([]),
  stories: z.array(StorySchema).default([]),
  image_references: z.array(ImageReferenceSchema).default([]),
  detected_language: z.enum(['en', 'es', 'unknown']),
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
