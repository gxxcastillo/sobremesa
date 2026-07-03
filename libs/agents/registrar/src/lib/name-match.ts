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
 * Stopwords excluded from "meaningful" token comparisons (English + the Romance
 * articles/prepositions common to the family languages this app supports), so
 * multilingual subjects like "la boda de María" don't spuriously match/mismatch
 * on function words. Shared by every module that filters name/subject tokens.
 */
export const MEANINGLESS_TOKENS = new Set([
  'the',
  'a',
  'an',
  'of',
  'in',
  'at',
  'to',
  'for',
  'on',
  'and',
  'or',
  's',
  'el',
  'la',
  'los',
  'las',
  'de',
  'del',
  'da',
  'do',
  'dos',
  'das',
  'du',
  'des',
  'le',
  'les',
]);

/**
 * Split text into lowercased word tokens, Unicode-aware so accented letters
 * (María, João, François) stay intact rather than being split on, unlike an
 * ASCII `\w`/`\b` tokenizer. With `foldDiacritics`, accents are stripped after
 * lowercasing so "María" and "Maria" tokenize identically.
 */
export function wordTokens(
  text: string,
  options?: { foldDiacritics?: boolean },
): string[] {
  const lower = text.toLowerCase();
  const normalized = options?.foldDiacritics
    ? lower.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC')
    : lower.normalize('NFC');
  return normalized.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
}

/**
 * True when every significant token of `name` is present in a token set already
 * computed from the candidate text (via `wordTokens`). Lets callers checking many
 * names against the same invariant text tokenize that text once instead of once
 * per name.
 */
export function nameMentionedInTokens(
  name: string,
  textTokens: ReadonlySet<string>,
  options?: {
    minTokenLength?: number;
    foldDiacritics?: boolean;
    stopwords?: ReadonlySet<string>;
  },
): boolean {
  const minTokenLength = options?.minTokenLength ?? 3;
  const nameTokens = wordTokens(name, options).filter(
    (t) => t.length >= minTokenLength && !options?.stopwords?.has(t),
  );
  if (nameTokens.length === 0) return false;
  return nameTokens.every((t) => textTokens.has(t));
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
  return nameMentionedInTokens(name, new Set(wordTokens(text)), {
    minTokenLength,
  });
}
