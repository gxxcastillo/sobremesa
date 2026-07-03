import { MEANINGLESS_TOKENS, wordTokens } from './name-match';

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
 * Detect if two claim values represent a conflict.
 * Returns true if values are contradictory, false if compatible.
 */
export function detectClaimConflict(
  existingValue: string | Record<string, unknown>,
  newValue: string | Record<string, unknown>,
): boolean {
  const existing = normalizeClaimValue(existingValue);
  const newVal = normalizeClaimValue(newValue);

  // Compare key fields for contradiction
  for (const key of Object.keys(newVal)) {
    if (key in existing) {
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
