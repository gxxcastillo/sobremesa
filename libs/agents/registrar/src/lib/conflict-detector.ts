import { MEANINGLESS_TOKENS, wordTokens } from '@sobremesa/shared-utils';

/**
 * Conflict detection utilities for the Registrar agent.
 */

function subjectTokens(subject: string): Set<string> {
  return new Set(
    wordTokens(subject).filter(
      (word) => word.length > 1 && !MEANINGLESS_TOKENS.has(word),
    ),
  );
}
/**
 * Claim types that should have a single value and can conflict.
 * These match the Scribe schema enum (minus 'detail' which is additive).
 *
 * Singular: date, location, identity, relationship
 * Additive: detail (never conflicts)
 */
const SINGULAR_CLAIM_TYPES = new Set([
  'date',
  'location',
  'identity',
  'relationship',
]);

/**
 * Check if a claim type can conflict with another claim of the same type.
 * Only singular claim types (where there should be one value) can conflict.
 */
export function canClaimTypeConflict(claimType: string): boolean {
  return SINGULAR_CLAIM_TYPES.has(claimType.toLowerCase());
}

/**
 * Normalize a claim value to Record format for comparison.
 * Handles both string (from LLM extraction) and Record (from database) formats.
 */
function normalizeClaimValue(
  value: string | Record<string, unknown>,
): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null ? parsed : { value };
    } catch {
      return { value };
    }
  }
  return value;
}

/**
 * Free-text fields that cite or explain a fact rather than assert it (e.g. a
 * date claim's `text: "at age 43"` alongside its structured `year`). Wording
 * differences here must not create a conflict on their own (#5d) — only when
 * one is the *only* value either side has does it become the fact itself.
 */
const CITATION_FIELDS = new Set(['text']);

function hasNonCitationField(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) => !CITATION_FIELDS.has(key));
}

/**
 * Scribe's relationship claims encode their counterparty in a free-text field
 * whose key isn't standardized (`to`, `relative`, `relatedTo`, `brothers`,
 * seen in real extractions) — only `relationshipType` itself is a fixed key.
 * Concatenate every other string-valued field into one descriptor to compare.
 */
function relationshipTargetText(value: Record<string, unknown>): string {
  return Object.entries(value)
    .filter(([key, v]) => key !== 'relationshipType' && typeof v === 'string')
    .map(([, v]) => v as string)
    .join(' ');
}

/**
 * A relationship claim only conflicts with another when both name the same
 * counterparty and disagree on the relationship type — "sibling to her
 * brothers" and "great-grandchild to our grandparents" are compatible facts
 * about different people, not a contradiction (#5d). Missing or ambiguous
 * target evidence on either side must not become a contradiction by
 * assumption: it makes the pair not comparable, not a conflict. Reuses
 * `subjectsMatch`'s whole-word-token Jaccard bar (verified live against a
 * real corpus: raw token-set overlap alone let a shared surname, "Enrique
 * Najlis" vs. "Jenny Najlis", read as the same person).
 */
function detectRelationshipConflict(
  existing: Record<string, unknown>,
  newVal: Record<string, unknown>,
): boolean {
  const existingType = existing['relationshipType'];
  const newType = newVal['relationshipType'];
  if (typeof existingType !== 'string' || typeof newType !== 'string') {
    return false;
  }
  if (existingType.toLowerCase().trim() === newType.toLowerCase().trim()) {
    return false;
  }

  const existingTarget = relationshipTargetText(existing);
  const newTarget = relationshipTargetText(newVal);
  if (!existingTarget || !newTarget) {
    return false;
  }

  return subjectsMatch(existingTarget, newTarget);
}

/**
 * Whether two claim values are the literal same fact, for deciding whether to
 * skip creating a claim as an exact duplicate of one that already exists.
 * This is *not* the same question as "do these conflict": for relationship
 * claims, `detectClaimConflict`'s "no conflict" result (#5d) also covers
 * compatible-but-different facts about the same subject (e.g. "sibling to her
 * brothers" and "great-grandchild to our grandparents") — those must not be
 * treated as duplicates of each other, or the second, distinct fact is
 * silently dropped instead of persisted.
 */
export function isExactDuplicateClaim(
  existingValue: string | Record<string, unknown>,
  newValue: string | Record<string, unknown>,
  claimType: string,
): boolean {
  if (claimType.toLowerCase() !== 'relationship') {
    return !detectClaimConflict(existingValue, newValue, claimType);
  }

  const existing = normalizeClaimValue(existingValue);
  const newVal = normalizeClaimValue(newValue);

  const existingType = existing['relationshipType'];
  const newType = newVal['relationshipType'];
  if (typeof existingType !== 'string' || typeof newType !== 'string') {
    return false;
  }
  if (existingType.toLowerCase().trim() !== newType.toLowerCase().trim()) {
    return false;
  }

  const existingTarget = relationshipTargetText(existing);
  const newTarget = relationshipTargetText(newVal);
  if (!existingTarget || !newTarget) {
    // Same type, but no comparable counterparty evidence on one or both
    // sides -- not confirmed as the same fact, so don't skip it.
    return existingTarget === newTarget;
  }

  return subjectsMatch(existingTarget, newTarget);
}

/**
 * Detect if two claim values represent a conflict.
 * Returns true if values are contradictory, false if compatible.
 */
export function detectClaimConflict(
  existingValue: string | Record<string, unknown>,
  newValue: string | Record<string, unknown>,
  claimType: string,
): boolean {
  const existing = normalizeClaimValue(existingValue);
  const newVal = normalizeClaimValue(newValue);

  if (claimType.toLowerCase() === 'relationship') {
    return detectRelationshipConflict(existing, newVal);
  }

  // Compare key fields for contradiction
  for (const key of Object.keys(newVal)) {
    if (key in existing) {
      if (
        CITATION_FIELDS.has(key) &&
        hasNonCitationField(existing) &&
        hasNonCitationField(newVal)
      ) {
        continue;
      }

      const existingField = existing[key];
      const newField = newVal[key];

      // Skip if either value is null/undefined
      if (existingField === undefined || existingField === null) continue;
      if (newField === undefined || newField === null) continue;

      // Both have values - check for conflict
      if (typeof existingField === 'number' && typeof newField === 'number') {
        // For numeric values (like years), allow a tolerance of 2
        if (Math.abs(existingField - newField) > 2) {
          return true;
        }
      } else if (
        typeof existingField === 'string' &&
        typeof newField === 'string'
      ) {
        // For string values, compare case-insensitively
        if (
          existingField.toLowerCase().trim() !== newField.toLowerCase().trim()
        ) {
          return true;
        }
      } else if (existingField !== newField) {
        // For other types, direct comparison
        return true;
      }
    }
  }

  return false;
}

/**
 * Score whether two subject strings refer to the same thing. Uses Jaccard over
 * whole-word tokens, not raw substring containment, so "wedding" does not match
 * every subject containing the word wedding.
 */
export function subjectMatchScore(subject1: string, subject2: string): number {
  const s1 = subject1.toLowerCase().trim();
  const s2 = subject2.toLowerCase().trim();

  if (s1 === s2) return 1;

  const words1 = subjectTokens(s1);
  const words2 = subjectTokens(s2);
  if (words1.size === 0 || words2.size === 0) return 0;
  // A single shared, generic content word is weak evidence of subject
  // identity — especially once multilingual articles/prepositions are
  // stripped, a short subject can collapse to one bare noun (e.g. "la
  // fiesta" -> {fiesta}). Require at least two meaningful tokens on each
  // side before trusting Jaccard overlap; below that, favor precision
  // (AGENTS.md invariant 6) over a possible false merge or duplicate-drop.
  if (words1.size < 2 || words2.size < 2) return 0;

  let intersection = 0;
  for (const word of words1) {
    if (words2.has(word)) intersection++;
  }

  const union = new Set([...words1, ...words2]).size;
  return intersection / union;
}

/**
 * Pick a single best subject match only when it is strong and unambiguous.
 */
export function findBestSubjectMatch(
  subject: string,
  candidates: Iterable<[string, string]>,
  threshold = 0.66,
  minMargin = 0.15,
): string | undefined {
  let bestId: string | undefined;
  let bestScore = 0;
  let runnerUpScore = 0;

  for (const [candidateSubject, candidateId] of candidates) {
    const score = subjectMatchScore(subject, candidateSubject);
    if (score > bestScore) {
      runnerUpScore = bestScore;
      bestScore = score;
      bestId = candidateId;
    } else if (score > runnerUpScore) {
      runnerUpScore = score;
    }
  }

  if (bestScore < threshold) return undefined;
  if (runnerUpScore > 0 && bestScore - runnerUpScore < minMargin) {
    return undefined;
  }
  return bestId;
}

/**
 * Check if a subject string matches another subject for conflict checking.
 */
export function subjectsMatch(subject1: string, subject2: string): boolean {
  return subjectMatchScore(subject1, subject2) >= 0.66;
}
