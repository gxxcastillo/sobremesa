/**
 * Conflict detection utilities for the Registrar agent.
 */

/**
 * Detect if two claim values represent a conflict.
 * Returns true if values are contradictory, false if compatible.
 */
export function detectClaimConflict(
  existingValue: Record<string, unknown>,
  newValue: Record<string, unknown>,
): boolean {
  // Compare key fields for contradiction
  for (const key of Object.keys(newValue)) {
    if (key in existingValue) {
      const existing = existingValue[key];
      const newVal = newValue[key];

      // Skip if either value is null/undefined
      if (existing === undefined || existing === null) continue;
      if (newVal === undefined || newVal === null) continue;

      // Both have values - check for conflict
      if (typeof existing === 'number' && typeof newVal === 'number') {
        // For numeric values (like years), allow a tolerance of 2
        if (Math.abs(existing - newVal) > 2) {
          return true;
        }
      } else if (typeof existing === 'string' && typeof newVal === 'string') {
        // For string values, compare case-insensitively
        if (existing.toLowerCase().trim() !== newVal.toLowerCase().trim()) {
          return true;
        }
      } else if (existing !== newVal) {
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
