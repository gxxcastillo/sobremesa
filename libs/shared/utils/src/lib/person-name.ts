/**
 * Classification of a person's `name` field: a real name, a description of
 * someone relative to another named person ("Ralph's sister", "la tía de
 * Juan" -- a "relational" placeholder), or a plain generic reference
 * ("someone", "the neighbor", or a speaker-relative term like "mi papá" --
 * a "generic" placeholder).
 *
 * Ported from the former `PersonRepository.isDescriptiveName`, fixing four
 * defects found against real extracted names: ASCII-only apostrophe
 * matching (curly apostrophes are routine LLM output), substring (not
 * word-boundary) matching on the Spanish relationship keywords (e.g.
 * "cristian" contains "tia"), a missing 'tía' keyword, and `\w` not
 * matching accented letters after "de" (e.g. "de Ángel").
 */
import { normalizeWhitespace } from './text-utils';

const ES_RELATIONSHIP_KEYWORDS = new Set([
  'hermano',
  'hermana',
  'hijo',
  'hija',
  'padre',
  'madre',
  'primo',
  'prima',
  'tío',
  'tio',
  'tía',
  'tia',
  'abuelo',
  'abuela',
  'nieto',
  'nieta',
  'sobrino',
  'sobrina',
  'esposo',
  'esposa',
  'ex-esposo',
  'ex-esposa',
  'novio',
  'novia',
  'bisabuelo',
  'bisabuela',
  'tatarabuelo',
  'tatarabuela',
  'hermanastro',
  'hermanastra',
  'padrastro',
  'madrastra',
]);

const ENGLISH_GENERIC_PATTERNS = [
  /^the\s+/i,
  /^unknown\s+/i,
  /^that\s+/i,
  /^someone$/i,
  /^somebody$/i,
];

const SPANISH_GENERIC_PATTERNS = [
  /^el\s+/i,
  /^la\s+/i,
  /^un\s+/i,
  /^una\s+/i,
  /^alguien$/i,
  /^alguno$/i,
  /^alguna$/i,
  /^desconocid[ao]$/i,
];

const SPEAKER_RELATIVE_PATTERN = /^(mi|mis|my|nuestr[oa]s?|our)\s+/i;

/** Curly/typographic apostrophes unified to the ASCII apostrophe, whitespace collapsed. */
function unifyApostrophesAndWhitespace(name: string): string {
  return normalizeWhitespace(name.replace(/[’ʼ‘]/g, "'"));
}

/**
 * Canonical form for exact comparison between two names. Follows
 * `name-match.ts`'s diacritic-folding idiom: lowercase, unify apostrophes,
 * fold diacritics (NFD -> strip combining marks -> NFC), collapse
 * whitespace. Two names that only differ by accent, curly-vs-straight
 * apostrophe, or incidental whitespace normalize to the same key.
 *
 * Deliberately independent of `classifyPersonName`: folding diacritics is
 * right for comparing two names, but wrong for keyword matching if the
 * keyword list ever needs an accent to tell two words apart (it does today,
 * for 'tio' vs 'tío').
 */
export function normalizeNameKey(name: string): string {
  const unified = unifyApostrophesAndWhitespace(name.toLowerCase());
  const foldedDiacritics = unified
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .normalize('NFC');
  return normalizeWhitespace(foldedDiacritics);
}

/**
 * "mi papá", "my mom", "nuestra tía" -- a relative term whose referent
 * depends on who is speaking, so it names a different person for each
 * speaker. Must never be matched on or stored as a durable alias.
 */
export function isSpeakerRelativeTerm(term: string): boolean {
  return SPEAKER_RELATIVE_PATTERN.test(unifyApostrophesAndWhitespace(term));
}

/**
 * Which kind of non-name this is, or null if it reads like a real name.
 *
 * - 'relational': describes someone by their relationship to a named person
 *   ("Ralph's sister", "la tía de Juan"). May only be matched or reused by
 *   exact normalized name -- never fuzzy or first-name matched, since a
 *   description is not the person it describes.
 * - 'generic': a plain generic reference ("someone", "the neighbor") or a
 *   speaker-relative term ("mi papá"). Never reused across mentions.
 */
export function classifyPersonName(
  name: string,
): 'relational' | 'generic' | null {
  const unified = unifyApostrophesAndWhitespace(name);
  const lower = unified.toLowerCase();

  // English possessive relationships: "Ralph's sister", "Timothy's son"
  if (lower.includes("'s ")) {
    return 'relational';
  }

  // Spanish relationship phrases: "la hermana de Ralph", "los hijos de Juan".
  // Take the text before the first "de <letter>", split into tokens, and
  // require a token that IS a keyword (or a keyword plus a plural s/es) --
  // not a substring match, which is what let "cristian" match "tia".
  const relationshipHead = /^(.*?)\s+de\s+\p{L}/iu.exec(lower)?.[1];
  if (relationshipHead !== undefined) {
    const tokens = relationshipHead
      .split(' ')
      .map((token) => token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''));
    for (const token of tokens) {
      if (
        ES_RELATIONSHIP_KEYWORDS.has(token) ||
        // Every keyword above ends in a vowel, so its plural is formed by
        // adding "s" alone (padre -> padres, tía -> tías) -- never "es".
        // Stripping an optional leading "e" too (`/e?s$/`) would wrongly eat
        // the keyword's own trailing "e" for a word like "padres"/"madres",
        // turning it into "padr"/"madr" and missing the match.
        ES_RELATIONSHIP_KEYWORDS.has(token.replace(/s$/, ''))
      ) {
        return 'relational';
      }
    }
  }

  if (isSpeakerRelativeTerm(unified)) {
    return 'generic';
  }

  for (const pattern of [
    ...ENGLISH_GENERIC_PATTERNS,
    ...SPANISH_GENERIC_PATTERNS,
  ]) {
    if (pattern.test(unified)) {
      return 'generic';
    }
  }

  return null;
}
