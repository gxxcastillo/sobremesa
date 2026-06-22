import { describe, it, expect } from 'vitest';
import {
  findBestSubjectMatch,
  subjectMatchScore,
  subjectsMatch,
} from './conflict-detector';

describe('subject matching', () => {
  it('does not match via raw substring containment (#5)', () => {
    expect(subjectsMatch('the wedding day', 'wedding')).toBe(false);
    expect(subjectMatchScore('the wedding day', 'wedding')).toBe(0.5);
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
