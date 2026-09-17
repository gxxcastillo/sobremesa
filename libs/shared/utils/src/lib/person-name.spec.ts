import { describe, it, expect } from 'vitest';
import {
  classifyPersonName,
  isSpeakerRelativeTerm,
  normalizeNameKey,
} from './person-name';

describe('classifyPersonName', () => {
  describe('English possessive relationships', () => {
    it('classifies "Ralph\'s sister" as relational', () => {
      expect(classifyPersonName("Ralph's sister")).toBe('relational');
    });

    it('classifies "Timothy\'s son" as relational', () => {
      expect(classifyPersonName("Timothy's son")).toBe('relational');
    });

    it('classifies "Eddie\'s ex-wife" as relational', () => {
      expect(classifyPersonName("Eddie's ex-wife")).toBe('relational');
    });

    it('does not classify "Ralph" as relational', () => {
      expect(classifyPersonName('Ralph')).toBeNull();
    });

    it('classifies a curly-apostrophe "Ralph’s sister" as relational (defect fix)', () => {
      expect(classifyPersonName('Ralph’s sister')).toBe('relational');
    });
  });

  describe('Spanish possessive relationships', () => {
    it('classifies "la hermana de Ralph" as relational', () => {
      expect(classifyPersonName('la hermana de Ralph')).toBe('relational');
    });

    it('classifies "el hijo de Timothy" as relational', () => {
      expect(classifyPersonName('el hijo de Timothy')).toBe('relational');
    });

    it('classifies "la ex-esposa de Eddie" as relational', () => {
      expect(classifyPersonName('la ex-esposa de Eddie')).toBe('relational');
    });

    it('classifies "el primo de Maria" as relational', () => {
      expect(classifyPersonName('el primo de Maria')).toBe('relational');
    });

    it('classifies "la abuela de Juan" as relational', () => {
      expect(classifyPersonName('la abuela de Juan')).toBe('relational');
    });

    it('does not classify "Maria de los Angeles" as relational (name with "de")', () => {
      // Contains "de" but no relationship keyword token before it.
      expect(classifyPersonName('Maria de los Angeles')).toBeNull();
    });

    it('classifies "la tía de Juan" as relational, not just generic (defect fix)', () => {
      // Today only caught by the generic "^la " pattern -- 'tía' (accented)
      // was missing from the old keyword list entirely.
      expect(classifyPersonName('la tía de Juan')).toBe('relational');
    });

    it('classifies "la hermana de Ángel" as relational, not just generic (defect fix)', () => {
      // Today "\w" after "de " does not match the accented "Á".
      expect(classifyPersonName('la hermana de Ángel')).toBe('relational');
    });

    it('classifies plural "los hijos de Juan" as relational', () => {
      expect(classifyPersonName('los hijos de Juan')).toBe('relational');
    });

    it('classifies plural "las sobrinas de Elena" as relational', () => {
      expect(classifyPersonName('las sobrinas de Elena')).toBe('relational');
    });

    it('classifies compound "el bisabuelo de Juan" as relational', () => {
      expect(classifyPersonName('el bisabuelo de Juan')).toBe('relational');
    });

    it('classifies compound "la madrastra de Ana" as relational', () => {
      expect(classifyPersonName('la madrastra de Ana')).toBe('relational');
    });
  });

  describe('does not substring-match unrelated names (defect fix)', () => {
    it('does not classify "Cristian de Jesús" as relational or generic', () => {
      // "cristian" contains the substring "tia" -- the old substring check
      // false-positived this real name as a placeholder.
      expect(classifyPersonName('Cristian de Jesús')).toBeNull();
    });

    it('does not classify "Sebastian de la Cruz" as relational or generic', () => {
      expect(classifyPersonName('Sebastian de la Cruz')).toBeNull();
    });
  });

  describe('English generic descriptors', () => {
    it('classifies "the neighbor" as generic', () => {
      expect(classifyPersonName('the neighbor')).toBe('generic');
    });

    it('classifies "unknown man" as generic', () => {
      expect(classifyPersonName('unknown man')).toBe('generic');
    });

    it('classifies "that friend" as generic', () => {
      expect(classifyPersonName('that friend')).toBe('generic');
    });

    it('classifies "someone" as generic', () => {
      expect(classifyPersonName('someone')).toBe('generic');
    });

    it('classifies "somebody" as generic', () => {
      expect(classifyPersonName('somebody')).toBe('generic');
    });

    it('does not classify bare "Unknown" as generic (createPlaceholder relies on this)', () => {
      expect(classifyPersonName('Unknown')).toBeNull();
    });
  });

  describe('Spanish generic descriptors', () => {
    it('classifies "el vecino" as generic', () => {
      expect(classifyPersonName('el vecino')).toBe('generic');
    });

    it('classifies "la vecina" as generic', () => {
      expect(classifyPersonName('la vecina')).toBe('generic');
    });

    it('classifies "un hombre" as generic', () => {
      expect(classifyPersonName('un hombre')).toBe('generic');
    });

    it('classifies "una mujer" as generic', () => {
      expect(classifyPersonName('una mujer')).toBe('generic');
    });

    it('classifies "alguien" as generic', () => {
      expect(classifyPersonName('alguien')).toBe('generic');
    });

    it('classifies "desconocido" as generic', () => {
      expect(classifyPersonName('desconocido')).toBe('generic');
    });

    it('classifies "desconocida" as generic', () => {
      expect(classifyPersonName('desconocida')).toBe('generic');
    });
  });

  describe('speaker-relative terms', () => {
    it('classifies "mi papá" as generic', () => {
      expect(classifyPersonName('mi papá')).toBe('generic');
    });

    it('classifies "my mom" as generic', () => {
      expect(classifyPersonName('my mom')).toBe('generic');
    });

    it('classifies "nuestra tía" as generic, not relational', () => {
      expect(classifyPersonName('nuestra tía')).toBe('generic');
    });
  });

  describe('real names (should not be relational or generic)', () => {
    it('does not classify "John Smith"', () => {
      expect(classifyPersonName('John Smith')).toBeNull();
    });

    it('does not classify "María García"', () => {
      expect(classifyPersonName('María García')).toBeNull();
    });

    it('does not classify "Robert"', () => {
      expect(classifyPersonName('Robert')).toBeNull();
    });

    it('does not classify "Grandmother Rose" (name includes relationship word)', () => {
      expect(classifyPersonName('Grandmother Rose')).toBeNull();
    });
  });
});

describe('isSpeakerRelativeTerm', () => {
  it('is true for "mi papá"', () => {
    expect(isSpeakerRelativeTerm('mi papá')).toBe(true);
  });

  it('is true for "my mom"', () => {
    expect(isSpeakerRelativeTerm('my mom')).toBe(true);
  });

  it('is true for "nuestra tía"', () => {
    expect(isSpeakerRelativeTerm('nuestra tía')).toBe(true);
  });

  it('is true for "nuestro tío"', () => {
    expect(isSpeakerRelativeTerm('nuestro tío')).toBe(true);
  });

  it('is true for "our uncle"', () => {
    expect(isSpeakerRelativeTerm('our uncle')).toBe(true);
  });

  it('is false for "Geraldine"', () => {
    expect(isSpeakerRelativeTerm('Geraldine')).toBe(false);
  });

  it('is false for "la tía de Juan" (relative to a named person, not the speaker)', () => {
    expect(isSpeakerRelativeTerm('la tía de Juan')).toBe(false);
  });
});

describe('normalizeNameKey', () => {
  it('lowercases', () => {
    expect(normalizeNameKey('RALPH')).toBe(normalizeNameKey('ralph'));
    expect(normalizeNameKey('Ralph')).toBe('ralph');
  });

  it('unifies curly and straight apostrophes', () => {
    expect(normalizeNameKey('Ralph’s sister')).toBe(
      normalizeNameKey("Ralph's sister"),
    );
    expect(normalizeNameKey('Ralphʼs sister')).toBe(
      normalizeNameKey("Ralph's sister"),
    );
  });

  it('collapses and trims extra whitespace', () => {
    expect(normalizeNameKey("  Ricardo   Hermoso's   father  ")).toBe(
      normalizeNameKey("Ricardo Hermoso's father"),
    );
  });

  it('folds accents', () => {
    expect(normalizeNameKey('María')).toBe(normalizeNameKey('Maria'));
    expect(normalizeNameKey('tío')).toBe(normalizeNameKey('tio'));
  });

  it('combines all normalizations into one stable key', () => {
    expect(normalizeNameKey('  Ricardo Hermoso’s   Father ')).toBe(
      normalizeNameKey("ricardo hermoso's father"),
    );
  });
});
