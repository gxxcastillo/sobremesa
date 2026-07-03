import { describe, it, expect } from 'vitest';
import {
  findBestSubjectMatch,
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
