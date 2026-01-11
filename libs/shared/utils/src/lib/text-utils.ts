/**
 * Text utility functions for Sobremesa.
 */

/**
 * Truncate text to a maximum length with ellipsis.
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

/**
 * Normalize whitespace in text.
 */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Check if text contains any of the keywords (case-insensitive).
 */
export function containsKeyword(text: string, keywords: string[]): boolean {
  const lowerText = text.toLowerCase();
  return keywords.some((keyword) => lowerText.includes(keyword.toLowerCase()));
}

/**
 * Extract all matches of a pattern from text.
 */
export function extractMatches(text: string, pattern: RegExp): string[] {
  const matches: string[] = [];
  const globalPattern = new RegExp(pattern.source, pattern.flags + 'g');
  let match;
  while ((match = globalPattern.exec(text)) !== null) {
    matches.push(match[0]);
  }
  return matches;
}

/**
 * Calculate similarity between two strings (Jaccard index on words).
 */
export function similarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));

  const intersection = new Set([...wordsA].filter((x) => wordsB.has(x)));
  const union = new Set([...wordsA, ...wordsB]);

  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

/**
 * Fuzzy match names considering common variations.
 */
export function fuzzyMatchName(name1: string, name2: string): boolean {
  const n1 = name1.toLowerCase().trim();
  const n2 = name2.toLowerCase().trim();

  // Exact match
  if (n1 === n2) return true;

  // One contains the other
  if (n1.includes(n2) || n2.includes(n1)) return true;

  // High similarity
  if (similarity(n1, n2) > 0.7) return true;

  return false;
}

/**
 * Generate a unique identifier for deduplication.
 */
export function generateDedupeKey(...parts: (string | undefined)[]): string {
  return parts
    .filter(Boolean)
    .map((p) => p!.toLowerCase().trim())
    .join('::');
}

/**
 * Escape special regex characters in a string.
 */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Split text into sentences (simple heuristic).
 */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
