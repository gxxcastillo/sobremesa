import { describe, expect, it } from 'vitest';
import {
  familyPrimaryLanguage,
  isFamilyPaused,
  type FamilyConfig,
} from './conversation';

describe('familyPrimaryLanguage', () => {
  it('reads defaultLanguage from an import-shaped config', () => {
    // What Studio import and `sbm import` write: no `languages` key at all.
    const config = {
      defaultLanguage: 'es',
      timezone: 'America/Managua',
      importSource: 'whatsapp',
    } as FamilyConfig;
    expect(familyPrimaryLanguage(config)).toBe('es');
  });

  it('prefers languages.primary over defaultLanguage', () => {
    expect(
      familyPrimaryLanguage({
        languages: { primary: 'en' },
        defaultLanguage: 'es',
      }),
    ).toBe('en');
  });

  it('skips an unsupported value and falls through to the next key', () => {
    expect(
      familyPrimaryLanguage({
        languages: { primary: 'pt' } as unknown as FamilyConfig['languages'],
        defaultLanguage: 'es',
      }),
    ).toBe('es');
    expect(familyPrimaryLanguage({ defaultLanguage: 'unknown' })).toBe(
      undefined,
    );
  });

  it('returns undefined when no language is configured', () => {
    expect(familyPrimaryLanguage({})).toBe(undefined);
    expect(familyPrimaryLanguage(undefined)).toBe(undefined);
    expect(familyPrimaryLanguage(null)).toBe(undefined);
  });
});

describe('isFamilyPaused (#6a)', () => {
  it('is true only when paused is exactly true', () => {
    expect(isFamilyPaused({ paused: true })).toBe(true);
  });

  it('is false when unset, false, or the config is missing entirely', () => {
    expect(isFamilyPaused({})).toBe(false);
    expect(isFamilyPaused({ paused: false })).toBe(false);
    expect(isFamilyPaused(undefined)).toBe(false);
    expect(isFamilyPaused(null)).toBe(false);
  });
});
