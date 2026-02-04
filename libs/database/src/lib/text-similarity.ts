const STOPWORDS = new Set([
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
  'but',
  'is',
  'was',
  'were',
  'been',
  'be',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'not',
  'el',
  'la',
  'los',
  'las',
  'de',
  'en',
  'y',
  'o',
  'un',
  'una',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/** Word-overlap coefficient: |intersection| / min(|A|, |B|). Returns 0–1. */
export function wordOverlapSimilarity(a: string, b: string): number {
  const tokensA = new Set(tokenize(a));
  const tokensB = new Set(tokenize(b));

  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++;
  }

  return intersection / Math.min(tokensA.size, tokensB.size);
}

/** Jaccard similarity for string arrays: |intersection| / |union|. Returns 0–1. */
export function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);

  if (setA.size === 0 && setB.size === 0) return 0;

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }

  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}
