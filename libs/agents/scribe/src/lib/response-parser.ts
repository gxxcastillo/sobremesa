import type {
  Confidence,
  ScribeDomainModel,
  ExtractedPerson,
  ExtractedPlace,
  ExtractedEvent,
  ExtractedRelationship,
  ExtractedClaim,
  ImageReference,
  RawImageReference,
  LanguageCode,
  InterpretationMetadata,
} from '@sobremesa/shared-types';
import { createLogger } from '@sobremesa/shared-utils';
import { RawScribeResponseSchema, type RawScribeResponse } from './schema';

const logger = createLogger({ name: 'scribe-parser' });

type RawEventDate = RawScribeResponse['events'][number]['date'];

/**
 * Thrown when the Scribe response cannot be parsed into a valid domain model.
 *
 * This MUST propagate (never be swallowed into an empty model): a silent empty
 * result is indistinguishable from "nothing to extract", so the processor would
 * mark the event `done` and the extraction would be lost. Because
 * `conversation_events` is immutable, letting this throw means the queue retries
 * and ultimately dead-letters the event, keeping it re-extractable.
 * See spec `agent-pipeline.md` §3.3 (atomic & recoverable extraction).
 */
export class ScribeParseError extends Error {
  readonly conversationEventId: string;
  constructor(
    message: string,
    conversationEventId: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = 'ScribeParseError';
    this.conversationEventId = conversationEventId;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * Infer confidence from certainty language.
 */
function inferConfidence(certaintyLanguage?: string): Confidence {
  if (!certaintyLanguage) return 'medium';
  const lower = certaintyLanguage.toLowerCase();
  if (
    lower.includes('definitely') ||
    lower.includes('certainly') ||
    lower.includes('always')
  ) {
    return 'high';
  }
  if (
    lower.includes('maybe') ||
    lower.includes('might') ||
    lower.includes('possibly') ||
    lower.includes('not sure')
  ) {
    return 'low';
  }
  return 'medium';
}

function normalizeYear(year: number): number | undefined {
  if (year >= 1800 && year <= 2029) return year;
  if (year >= 0 && year <= 29) return 2000 + year;
  if (year >= 30 && year <= 99) return 1900 + year;
  return undefined;
}

function extractYearFromText(dateText?: string): number | undefined {
  if (!dateText) return undefined;
  const fourDigit = dateText.match(/\b(1[89]\d{2}|20[0-2]\d)\b/);
  if (fourDigit) return parseInt(fourDigit[1], 10);
  const twoDigit = dateText.match(/\b(?:'|’)?(\d{2})\b/);
  return twoDigit ? normalizeYear(parseInt(twoDigit[1], 10)) : undefined;
}

function parseEventDate(date?: RawEventDate): {
  dateText?: string;
  dateYear?: number;
} {
  if (!date) return {};

  if (typeof date === 'object') {
    const dateText = date.text;
    const dateYear =
      typeof date.year === 'number'
        ? normalizeYear(date.year)
        : extractYearFromText(dateText);
    return { dateText, dateYear };
  }

  if (date.startsWith('{')) {
    try {
      const parsed = JSON.parse(date) as {
        year?: unknown;
        text?: unknown;
      };
      const dateText = typeof parsed.text === 'string' ? parsed.text : date;
      const dateYear =
        typeof parsed.year === 'number'
          ? normalizeYear(parsed.year)
          : extractYearFromText(dateText);
      return { dateText, dateYear };
    } catch {
      // not valid JSON, parse as plain text
    }
  }

  return {
    dateText: date,
    dateYear: extractYearFromText(date),
  };
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
  conversationEventId: string,
  familyId: string,
  preprocessed?: {
    detectedLanguage?: LanguageCode;
    imageReferences?: RawImageReference[];
  },
): ScribeDomainModel {
  // Parse JSON first. Invalid JSON fails loud (see ScribeParseError) — never a
  // silent empty model, which would be marked done and lose the extraction.
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(extractJson(rawText));
  } catch (error) {
    logger.warn(
      { err: error, rawText: rawText.slice(0, 500) },
      'Scribe response is not valid JSON',
    );
    throw new ScribeParseError(
      'Scribe response is not valid JSON',
      conversationEventId,
      { cause: error },
    );
  }

  // Validate against the schema. Malformed entity data fails loud; only the
  // metadata fields (understood_message, detected_language) degrade via .catch()
  // in the schema itself — entity arrays do not, so a bad element reaches here.
  const parseResult = RawScribeResponseSchema.safeParse(parsedJson);
  if (!parseResult.success) {
    logger.warn(
      { error: parseResult.error.flatten(), rawText: rawText.slice(0, 500) },
      'Zod validation failed for Scribe response',
    );
    throw new ScribeParseError(
      'Scribe response failed schema validation',
      conversationEventId,
      { cause: parseResult.error },
    );
  }

  const raw: RawScribeResponse = parseResult.data;

  // Log understood message for debugging pronoun resolution
  if (raw.understood_message) {
    logger.debug(
      {
        conversationEventId,
        resolvedText: raw.understood_message.resolved_text,
        ambiguousReferences: raw.understood_message.ambiguous_references,
        resolutionConfidence: raw.understood_message.resolution_confidence,
      },
      'Scribe understood message',
    );
  }

  // Parse people (confidence removed from schema, default to MEDIUM)
  const people: ExtractedPerson[] = raw.people.map((p) => ({
    name: p.name,
    aliases: p.aliases,
    birthYear: p.birth_year,
    deathYear: p.death_year,
    confidence: 'medium',
  }));

  // Parse places
  const places: ExtractedPlace[] = raw.places.map((p) => ({
    name: p.name,
    type: p.type,
    city: p.city,
    region: p.region,
    country: p.country,
    confidence: 'medium',
  }));

  // Parse events
  const events: ExtractedEvent[] = raw.events.map((e) => {
    const parsedDate = parseEventDate(e.date);
    return {
      title: e.title,
      eventType: e.event_type,
      dateText: parsedDate.dateText,
      dateYear: parsedDate.dateYear,
      peopleInvolved: e.people_involved,
      placeName: e.place,
      confidence: 'medium',
    };
  });

  // Parse relationships (confidence removed from schema)
  const relationships: ExtractedRelationship[] = raw.relationships.map((r) => ({
    personAName: r.person_a,
    personBName: r.person_b,
    relationshipType: r.relationship_type,
    confidence: 'medium',
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
    referencedPeople: c.referenced_people,
    referencedPlaces: c.referenced_places,
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
  const imageReferences: ImageReference[] = (raw.image_references || []).map(
    (r) => ({
      imageId: r.image_id,
      referenceType: parseImageReferenceType(r.reference_type),
      peopleIdentified: r.people_identified,
      contextProvided: r.context_provided,
      confidence: 'medium',
    }),
  );

  // Convert raw image references to full ImageReference with confidence
  const finalImageReferences: ImageReference[] = preprocessed?.imageReferences
    ? preprocessed.imageReferences.map((ref) => ({
        peopleIdentified: [],
        ...ref,
        confidence: 'medium',
      }))
    : imageReferences;

  // Build interpretation metadata from understood_message
  let interpretation: InterpretationMetadata | undefined;
  if (raw.understood_message) {
    interpretation = {
      resolvedText: raw.understood_message.resolved_text,
      ambiguousReferences: raw.understood_message.ambiguous_references.map(
        (ref) => ({
          token: ref.token,
          candidates: ref.candidates,
          selected: ref.selected,
          confidence: ref.confidence,
        }),
      ),
      resolutionConfidence: raw.understood_message.resolution_confidence,
    };
  }

  return {
    conversationEventId,
    familyId,
    processedAt: new Date(),
    people,
    places,
    events,
    relationships,
    claims,
    story,
    imageReferences: finalImageReferences,
    detectedLanguage: preprocessed?.detectedLanguage || raw.detected_language,
    interpretation,
  };
}
