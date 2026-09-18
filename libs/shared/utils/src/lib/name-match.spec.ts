import { describe, it, expect } from 'vitest';
import { textMentionsName, wordTokens } from './name-match';

describe('textMentionsName — word-boundary claim→person matching', () => {
  it('does NOT match a name embedded inside a larger word', () => {
    // The bug this fixes: unbounded substring containment.
    expect(textMentionsName('she peeled a banana', 'Ann')).toBe(false);
    expect(textMentionsName('anna baked bread', 'Ana')).toBe(false);
    expect(textMentionsName('steve drove home', 'Eve')).toBe(false);
  });

  it('matches a name that appears as a whole word', () => {
    expect(textMentionsName("Ann's wedding day", 'Ann')).toBe(true);
    expect(textMentionsName('a gift from Eve', 'Eve')).toBe(true);
  });

  it('keeps accented names intact (Unicode-aware)', () => {
    expect(textMentionsName('la boda de María', 'María')).toBe(true);
    expect(textMentionsName('o aniversário do João', 'João')).toBe(true);
    // still anchored — "Mar" must not match inside "María"
    expect(textMentionsName('la boda de María', 'Mar')).toBe(false);
  });

  it('requires all significant tokens of a multi-word name', () => {
    expect(textMentionsName('a photo of Maria Garcia', 'Maria Garcia')).toBe(
      true,
    );
    // order-independent
    expect(textMentionsName('Garcia, Maria attended', 'Maria Garcia')).toBe(
      true,
    );
    // missing one token → no match
    expect(textMentionsName('a photo of Maria', 'Maria Garcia')).toBe(false);
  });

  it('never matches when the name has no significant tokens', () => {
    expect(textMentionsName('we saw Bo today', 'Bo')).toBe(false);
  });

  it('wordTokens splits on punctuation and lowercases', () => {
    expect(wordTokens("Maria's birth, 1950!")).toEqual([
      'maria',
      's',
      'birth',
      '1950',
    ]);
  });
});
