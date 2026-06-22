/**
 * Word-boundary name matching for claim→entity linking.
 *
 * Entity resolution favors precision over recall (spec overview §1.7 invariant 6):
 * a false link permanently pollutes the knowledge graph and is worse than a missed
 * one. Raw substring containment (`text.includes(name)`) is unanchored — 'Ann'
 * matches inside 'Anna'/'banana', 'Eve' inside 'Steve' — so matching here is
 * anchored to whole words instead.
 */

/**
 * Split text into lowercased word tokens, Unicode-aware so accented letters
 * (María, João, François) stay intact rather than being split on, unlike an
 * ASCII `\w`/`\b` tokenizer.
 */
export function wordTokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

/**
 * True when every significant token of `name` appears as a whole word in `text`.
 * Tokens shorter than `minTokenLength` are ignored as noise; a name with no
 * significant tokens never matches (mirrors the old `name.length < 3` guard, but
 * per-token and anchored). Order-independent, so "Maria Garcia" matches
 * "...Garcia, Maria...".
 */
export function textMentionsName(
  text: string,
  name: string,
  minTokenLength = 3,
): boolean {
  const nameTokens = wordTokens(name).filter((t) => t.length >= minTokenLength);
  if (nameTokens.length === 0) return false;
  const textTokens = new Set(wordTokens(text));
  return nameTokens.every((t) => textTokens.has(t));
}
