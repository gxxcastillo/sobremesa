/**
 * Conflict detection utilities for the Registrar agent.
 */

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
 * Check if a subject string matches another subject for conflict checking.
 */
export function subjectsMatch(subject1: string, subject2: string): boolean {
  const s1 = subject1.toLowerCase().trim();
  const s2 = subject2.toLowerCase().trim();

  // Exact match
  if (s1 === s2) return true;

  // One contains the other
  if (s1.includes(s2) || s2.includes(s1)) return true;

  // Both contain the same key terms (for compound subjects)
  const words1 = new Set(s1.split(/\s+/).filter((w) => w.length > 3));
  const words2 = new Set(s2.split(/\s+/).filter((w) => w.length > 3));
  const intersection = [...words1].filter((w) => words2.has(w));

  // If they share most key words, consider them matching
  const totalUnique = new Set([...words1, ...words2]).size;
  if (totalUnique > 0 && intersection.length / totalUnique > 0.5) {
    return true;
  }

  return false;
}
