import { describe, it, expect } from 'vitest';
import {
  detectClaimConflict,
  findBestSubjectMatch,
  isExactDuplicateClaim,
  subjectMatchScore,
  subjectsMatch,
} from './conflict-detector';

describe('subject matching', () => {
  it('does not match via raw substring containment (#5)', () => {
    expect(subjectsMatch('the wedding day', 'wedding')).toBe(false);
    // 'wedding' alone is a single meaningful token — below the two-token
    // floor that guards against a single shared generic word being treated
    // as evidence of subject identity (see subjectMatchScore).
    expect(subjectMatchScore('the wedding day', 'wedding')).toBe(0);
  });

  it('treats a single shared token after stripping a multilingual article as unrelated', () => {
    // 'la' is stripped as a meaningless token, collapsing 'la fiesta' to the
    // single word {fiesta} — same degenerate shape as the English case
    // above, just reached via multilingual stopword-stripping instead of a
    // multi-word phrase.
    expect(subjectMatchScore('la fiesta', 'fiesta')).toBe(0);
    expect(subjectsMatch('la fiesta', 'fiesta')).toBe(false);
  });

  it('matches strong whole-token overlap', () => {
    expect(subjectsMatch("Maria's birth date", "Maria's birth")).toBe(true);
  });

  it('selects the best event subject instead of first loose match (#5)', () => {
    const eventId = findBestSubjectMatch(
      'Maria Havana wedding reception',
      new Map([
        ['wedding', 'event-too-generic'],
        ['Havana wedding reception', 'event-specific'],
      ]),
    );

    expect(eventId).toBe('event-specific');
  });

  it('returns no match when top candidates are ambiguous (#5)', () => {
    const eventId = findBestSubjectMatch(
      'Havana wedding',
      new Map([
        ['Havana wedding ceremony', 'event-ceremony'],
        ['Havana wedding reception', 'event-reception'],
      ]),
    );

    expect(eventId).toBeUndefined();
  });
});

describe('detectClaimConflict — value comparison (#5d)', () => {
  describe('relationship claims: only same-counterparty type mismatches conflict', () => {
    it('does not conflict when the counterparties are different people (real corpus case)', () => {
      // Luciana Rose Castillo: "sibling" to her brothers vs. "great-grandchild"
      // to "our grandparents" — compatible facts about different people.
      expect(
        detectClaimConflict(
          { relationshipType: 'sibling', to: 'her brothers' },
          { relationshipType: 'great-grandchild', to: 'our grandparents' },
          'relationship',
        ),
      ).toBe(false);
    });

    it('conflicts when the same named counterparty gets two different relationship types', () => {
      expect(
        detectClaimConflict(
          { relationshipType: 'parent', relative: 'Enrique Najlis' },
          { relationshipType: 'sibling', relative: 'Enrique Najlis' },
          'relationship',
        ),
      ).toBe(true);
    });

    it('does not conflict when a counterparty is missing or ambiguous on either side', () => {
      // No target evidence at all beyond relationshipType itself — missing
      // target evidence must not become a contradiction by assumption.
      expect(
        detectClaimConflict(
          { relationshipType: 'sibling' },
          { relationshipType: 'great-grandchild', to: 'our grandparents' },
          'relationship',
        ),
      ).toBe(false);
    });

    it('does not conflict when counterparties share only a surname (real corpus false positive)', () => {
      // "the baby in Leonardo's birthday photo": great-grandchild of Enrique
      // Najlis vs. grandchild of Jenny Najlis — two different people who
      // happen to share a family surname, not the same counterparty.
      expect(
        detectClaimConflict(
          { relationshipType: 'great-grandchild', relative: 'Enrique Najlis' },
          { relationshipType: 'grandchild', relative: 'Jenny Najlis' },
          'relationship',
        ),
      ).toBe(false);
    });

    it('does not conflict when the relationship type itself is unchanged', () => {
      expect(
        detectClaimConflict(
          { relationshipType: 'sibling', to: 'her brothers' },
          { relationshipType: 'sibling', to: 'her brothers' },
          'relationship',
        ),
      ).toBe(false);
    });
  });

  describe('citation-only text differences do not conflict', () => {
    it('does not conflict when a structured field agrees and only the citation text differs', () => {
      // Michel Vega's heart attack: both say year 2018, only the citation
      // ("at age 43" vs. "8 years ago") differs in wording.
      expect(
        detectClaimConflict(
          { year: 2018, text: 'at age 43' },
          { year: 2018, text: '8 years ago' },
          'date',
        ),
      ).toBe(false);
    });

    it('still conflicts when the structured field itself disagrees', () => {
      expect(
        detectClaimConflict(
          { year: 2018, text: 'at age 43' },
          { year: 2024, text: 'at age 43' },
          'date',
        ),
      ).toBe(true);
    });

    it('compares the citation text as the fact when it is the only value either side has', () => {
      expect(
        detectClaimConflict(
          { text: 'at age 43' },
          { text: '8 years ago' },
          'date',
        ),
      ).toBe(true);
    });
  });

  it('still flags a genuine non-relationship value conflict (regression)', () => {
    expect(
      detectClaimConflict(
        { value: 'Costa Rica' },
        { value: 'Miami' },
        'location',
      ),
    ).toBe(true);
  });
});

describe('isExactDuplicateClaim', () => {
  it('is not an exact duplicate when relationship claims are compatible but distinct facts', () => {
    // Regression: detectClaimConflict's "no conflict" for #5d's
    // compatible-but-different-counterparty case must not be read as "same
    // fact" by the caller that decides whether to skip creating a claim.
    expect(
      isExactDuplicateClaim(
        { relationshipType: 'sibling', to: 'her brothers' },
        { relationshipType: 'great-grandchild', to: 'our grandparents' },
        'relationship',
      ),
    ).toBe(false);
  });

  it('is an exact duplicate when a relationship claim repeats the same type and counterparty', () => {
    expect(
      isExactDuplicateClaim(
        { relationshipType: 'sibling', to: 'her brothers' },
        { relationshipType: 'sibling', to: 'her brothers' },
        'relationship',
      ),
    ).toBe(true);
  });

  it('is not an exact duplicate when relationship type matches but counterparty evidence is missing on one side', () => {
    expect(
      isExactDuplicateClaim(
        { relationshipType: 'sibling', to: 'her brothers' },
        { relationshipType: 'sibling' },
        'relationship',
      ),
    ).toBe(false);
  });

  it('falls back to detectClaimConflict for non-relationship claim types', () => {
    expect(isExactDuplicateClaim({ year: 2018 }, { year: 2018 }, 'date')).toBe(
      true,
    );
    expect(isExactDuplicateClaim({ year: 2018 }, { year: 2024 }, 'date')).toBe(
      false,
    );
  });
});
