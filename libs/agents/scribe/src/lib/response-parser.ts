import {
  Confidence,
  type ScribeDomainModel,
  type ExtractedPerson,
  type ExtractedPlace,
  type ExtractedEvent,
  type ExtractedRelationship,
  type ExtractedClaim,
  type GeneratedQuestion,
  type DetectedAnswer,
  type DetectedConflict,
  type LanguageCode,
} from '@sobremesa/shared-types';
import { createLogger } from '@sobremesa/shared-utils';
import type { RawScribeResponse } from './types.js';

const logger = createLogger({ name: 'scribe-parser' });

/**
 * Parse confidence string to Confidence enum.
 */
function parseConfidence(value?: string): Confidence {
  if (!value) return Confidence.MEDIUM;
  const lower = value.toLowerCase();
  if (lower === 'high' || lower === 'definite' || lower === 'certain') {
    return Confidence.HIGH;
  }
  if (lower === 'low' || lower === 'uncertain' || lower === 'guess') {
    return Confidence.LOW;
  }
  return Confidence.MEDIUM;
}

/**
 * Parse language code string to LanguageCode.
 */
function parseLanguage(value?: string): LanguageCode {
  if (!value) return 'en';
  const lower = value.toLowerCase();
  if (lower === 'es' || lower === 'spanish') return 'es';
  if (lower === 'mixed') return 'mixed';
  return 'en';
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
  claimedBy: string
): ScribeDomainModel {
  let raw: RawScribeResponse;

  try {
    const jsonStr = extractJson(rawText);
    raw = JSON.parse(jsonStr) as RawScribeResponse;
  } catch (error) {
    logger.warn({ error, rawText: rawText.slice(0, 500) }, 'Failed to parse Scribe response JSON');
    // Return empty domain model on parse failure
    return createEmptyDomainModel(sourceEventId, familyId);
  }

  // Parse people
  const people: ExtractedPerson[] = (raw.people || []).map((p) => ({
    name: p.name,
    aliases: p.aliases || [],
    birthYear: p.birth_year,
    deathYear: p.death_year,
    confidence: parseConfidence(p.confidence),
  }));

  // Parse places
  const places: ExtractedPlace[] = (raw.places || []).map((p) => ({
    name: p.name,
    type: p.type,
    city: p.city,
    region: p.region,
    country: p.country,
    confidence: parseConfidence(p.confidence),
  }));

  // Parse events
  const events: ExtractedEvent[] = (raw.events || []).map((e) => ({
    title: e.title,
    eventType: e.event_type,
    dateYear: e.date_year,
    dateMonth: e.date_month,
    dateDay: e.date_day,
    dateApproximate: e.date_approximate,
    peopleInvolved: e.people_involved || [],
    placeName: e.place,
    confidence: parseConfidence(e.confidence),
  }));

  // Parse relationships
  const relationships: ExtractedRelationship[] = (raw.relationships || []).map(
    (r) => ({
      personAName: r.person_a,
      personBName: r.person_b,
      relationshipType: r.relationship_type,
      confidence: parseConfidence(r.confidence),
    })
  );

  // Parse claims
  const claims: ExtractedClaim[] = (raw.claims || []).map((c) => ({
    claimType: c.claim_type,
    subject: c.subject,
    claimValue: c.claim_value,
    confidence: parseConfidence(c.confidence),
    certaintyLanguage: c.certainty_language,
    contextOriginal: c.context_original,
  }));

  // Parse story (take first one if multiple)
  const storyData = raw.stories?.[0];
  const story = storyData
    ? {
        title: storyData.title,
        content: storyData.content,
        themes: storyData.themes || [],
        timeframe: storyData.timeframe,
      }
    : undefined;

  // Parse questions
  const questions: GeneratedQuestion[] = (raw.questions || []).map((q) => ({
    content: q.question_original,
    language: parseLanguage(q.language_original),
    priority: q.priority ?? 50,
    origin: 'scribe' as const,
    targetPerson: q.target_person,
    targetEvent: q.target_event,
    targetPlace: q.target_place,
  }));

  // Parse answered questions
  const answers: DetectedAnswer[] = (raw.answered_questions || []).map((a) => ({
    questionId: a.question_id,
    answerContent: '', // Content is in the message itself
    confidence: parseConfidence(a.completeness === 'full' ? 'high' : 'medium'),
  }));

  // Parse conflicts
  const conflicts: DetectedConflict[] = (raw.conflicts || []).map((c) => ({
    existingClaimSubject: c.subject,
    existingClaimValue: c.existing_claim_value || {},
    newClaimValue: c.new_claim_value || {},
    conflictType:
      c.conflict_type === 'inconsistency' ? 'inconsistency' : 'contradiction',
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
    questions,
    answers,
    conflicts,
    detectedLanguage: parseLanguage(raw.detected_language),
  };
}

/**
 * Create an empty domain model (used when parsing fails).
 */
function createEmptyDomainModel(
  sourceEventId: string,
  familyId: string
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
    questions: [],
    answers: [],
    conflicts: [],
    detectedLanguage: 'en',
  };
}
