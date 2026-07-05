import { describe, it, expect } from 'vitest';
import { groundEvidence, normalizeForGrounding } from './grounding';

describe('normalizeForGrounding', () => {
  it('lowercases, folds diacritics, and collapses punctuation/whitespace', () => {
    expect(normalizeForGrounding('  María   nació en 1943!  ')).toBe(
      'maria nacio en 1943',
    );
  });

  it('returns empty string for punctuation-only input', () => {
    expect(normalizeForGrounding('... !!! ---')).toBe('');
  });
});

describe('groundEvidence — three-way rule (spec §3.4)', () => {
  const current = 'Grandpa Ernesto was born in Oaxaca in 1943.';
  const context = [
    'We visited Guadalajara last summer.',
    'Rosa moved from Oaxaca in 1965.',
  ];

  it('grounded: evidence appears verbatim in the current message', () => {
    expect(groundEvidence('born in Oaxaca in 1943', current, context)).toBe(
      'grounded',
    );
  });

  it('grounded despite case, diacritics, and punctuation differences', () => {
    expect(groundEvidence('GRANDPA ERNESTO, was bórn', current, context)).toBe(
      'grounded',
    );
  });

  it('grounded wins when the span appears in both current and context', () => {
    expect(groundEvidence('in 1943', current, ['also in 1943'])).toBe(
      'grounded',
    );
  });

  it('context_bleed: evidence appears only in a context message', () => {
    expect(groundEvidence('moved from Oaxaca in 1965', current, context)).toBe(
      'context_bleed',
    );
  });

  it('unmatched: evidence appears nowhere', () => {
    expect(groundEvidence('Ernesto loved mangoes', current, context)).toBe(
      'unmatched',
    );
  });

  it('unmatched: missing or empty evidence is flagged, never treated as bleed', () => {
    expect(groundEvidence(undefined, current, context)).toBe('unmatched');
    expect(groundEvidence('', current, context)).toBe('unmatched');
    expect(groundEvidence('!!!', current, context)).toBe('unmatched');
  });

  it('unmatched: no current content available (e.g. media event)', () => {
    expect(groundEvidence('born in 1943', undefined, [])).toBe('unmatched');
  });

  it('never reports bleed without current content, even when evidence matches context (spec §3.4: flag, never reject)', () => {
    expect(
      groundEvidence('moved from Oaxaca in 1965', undefined, [
        'Rosa moved from Oaxaca in 1965.',
      ]),
    ).toBe('unmatched');
    expect(
      groundEvidence('moved from Oaxaca in 1965', '', [
        'Rosa moved from Oaxaca in 1965.',
      ]),
    ).toBe('unmatched');
  });

  it('anchors on whole words: a span inside a longer word does not match', () => {
    // "Ann" must not ground against "Anna" (precision over recall).
    expect(groundEvidence('Ann', 'Anna visited yesterday', [])).toBe(
      'unmatched',
    );
  });

  it('matches across punctuation boundaries in the source text', () => {
    expect(
      groundEvidence('en 1943', 'María nació en 1943, en Oaxaca.', []),
    ).toBe('grounded');
  });
});
