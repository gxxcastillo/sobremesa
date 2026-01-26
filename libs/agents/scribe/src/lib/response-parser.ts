import {
  Confidence,
  type ScribeDomainModel,
  type ExtractedPerson,
  type ExtractedPlace,
  type ExtractedEvent,
  type ExtractedRelationship,
  type ExtractedClaim,
  type ImageReference,
} from '@sobremesa/shared-types';
import { createLogger } from '@sobremesa/shared-utils';
import { RawScribeResponseSchema, type RawScribeResponse } from './schema';

const logger = createLogger({ name: 'scribe-parser' });

/**
 * Infer confidence from certainty language.
 */
function inferConfidence(certaintyLanguage?: string): Confidence {
  if (!certaintyLanguage) return Confidence.MEDIUM;
  const lower = certaintyLanguage.toLowerCase();
  if (
    lower.includes('definitely') ||
    lower.includes('certainly') ||
    lower.includes('always')
  ) {
    return Confidence.HIGH;
  }
  if (
    lower.includes('maybe') ||
    lower.includes('might') ||
    lower.includes('possibly') ||
    lower.includes('not sure')
  ) {
    return Confidence.LOW;
  }
  return Confidence.MEDIUM;
}

/**
 * Extract a year from a date string like "1920", "summer 1920", "around 1889".
 */
function extractYear(dateText?: string): number | undefined {
  if (!dateText) return undefined;
  const match = dateText.match(/\b(1[89]\d{2}|20[0-2]\d)\b/);
  return match ? parseInt(match[1], 10) : undefined;
}

/**
 * Parse image reference type string.
 */
function parseImageReferenceType(
  value?: string,
): 'describes' | 'identifies_people' | 'provides_context' | 'asks_about' {
  if (!value) return 'describes';
  const lower = value.toLowerCase();
  if (lower === 'identifies_people' || lower === 'identifies people') {
    return 'identifies_people';
  }
  if (lower === 'provides_context' || lower === 'provides context') {
    return 'provides_context';
  }
  if (lower === 'asks_about' || lower === 'asks about') {
    return 'asks_about';
  }
  return 'describes';
}

/**
 * Extract JSON from Claude's response, handling markdown code blocks.
 */
function extractJson(text: string): string {
  // Try to find JSON in code blocks
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // Try to find raw JSON object
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return jsonMatch[0];
  }

  return text;
}

/**
 * Parse Claude's raw response into a ScribeDomainModel.
 */
export function parseScribeResponse(
  rawText: string,
  sourceEventId: string,
  familyId: string,
): ScribeDomainModel {
  let raw: RawScribeResponse;

  try {
    const jsonStr = extractJson(rawText);
    const parseResult = RawScribeResponseSchema.safeParse(JSON.parse(jsonStr));

    if (!parseResult.success) {
      logger.warn(
        { error: parseResult.error.flatten(), rawText: rawText.slice(0, 500) },
        'Zod validation failed for Scribe response',
      );
      return createEmptyDomainModel(sourceEventId, familyId);
    }

    raw = parseResult.data;
  } catch (error) {
    logger.warn(
      { error, rawText: rawText.slice(0, 500) },
      'Failed to parse Scribe response JSON',
    );
    return createEmptyDomainModel(sourceEventId, familyId);
  }

  // Parse people (confidence removed from schema, default to MEDIUM)
  const people: ExtractedPerson[] = raw.people.map((p) => ({
    name: p.name,
    aliases: p.aliases,
    birthYear: p.birth_year,
    deathYear: p.death_year,
    confidence: Confidence.MEDIUM,
  }));

  // Parse places
  const places: ExtractedPlace[] = raw.places.map((p) => ({
    name: p.name,
    type: p.type,
    city: p.city,
    region: p.region,
    country: p.country,
    confidence: Confidence.MEDIUM,
  }));

  // Parse events
  const events: ExtractedEvent[] = raw.events.map((e) => ({
    title: e.title,
    eventType: e.event_type,
    dateText: e.date,
    dateYear: extractYear(e.date),
    peopleInvolved: e.people_involved,
    placeName: e.place,
    confidence: Confidence.MEDIUM,
  }));

  // Parse relationships (confidence removed from schema)
  const relationships: ExtractedRelationship[] = raw.relationships.map((r) => ({
    personAName: r.person_a,
    personBName: r.person_b,
    relationshipType: r.relationship_type,
    confidence: Confidence.MEDIUM,
  }));

  // Parse claims (infer confidence from certainty_language)
  const claims: ExtractedClaim[] = raw.claims.map((c) => ({
    claimType: c.claim_type,
    subject: c.subject,
    claimValue: c.claim_value,
    confidence: inferConfidence(c.certainty_language),
    certaintyLanguage: c.certainty_language,
    claimedBy: c.claimed_by,
    claimedBySource: c.claimed_by_source,
  }));

  // Parse story (take first one if multiple)
  const storyData = raw.stories[0];
  const story = storyData
    ? {
        title: storyData.title,
        content: storyData.content,
        themes: storyData.themes,
        timeframe: storyData.timeframe,
      }
    : undefined;

  // Parse image references (confidence removed from schema)
  const imageReferences: ImageReference[] = raw.image_references.map((r) => ({
    imageId: r.image_id,
    referenceType: parseImageReferenceType(r.reference_type),
    peopleIdentified: r.people_identified,
    contextProvided: r.context_provided,
    confidence: Confidence.MEDIUM,
  }));

  return {
    sourceEventId,
    familyId,
    processedAt: new Date(),
    people,
    places,
    events,
    relationships,
    claims,
    story,
    imageReferences,
    detectedLanguage: raw.detected_language,
  };
}

/**
 * Create an empty domain model (used when parsing fails).
 */
function createEmptyDomainModel(
  sourceEventId: string,
  familyId: string,
): ScribeDomainModel {
  return {
    sourceEventId,
    familyId,
    processedAt: new Date(),
    people: [],
    places: [],
    events: [],
    relationships: [],
    claims: [],
    imageReferences: [],
    detectedLanguage: 'en',
  };
}
