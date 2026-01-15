import { loadPrompt } from './prompts';

describe('prompts', () => {
  describe('loadPrompt', () => {
    it('should load all agent prompts', () => {
      expect(loadPrompt('admin')).toBeDefined();
      expect(loadPrompt('curator')).toBeDefined();
      expect(loadPrompt('facilitator')).toBeDefined();
      expect(loadPrompt('historian')).toBeDefined();
      expect(loadPrompt('internFilter')).toBeDefined();
      expect(loadPrompt('internImageLink')).toBeDefined();
      expect(loadPrompt('scribe')).toBeDefined();
    });

    it('should return non-empty prompt content', () => {
      expect(loadPrompt('curator').length).toBeGreaterThan(0);
      expect(loadPrompt('historian').length).toBeGreaterThan(0);
    });

    it('should replace placeholders with values', () => {
      const result = loadPrompt('historian', {
        HISTORIAN_NAME: 'TestHistorian',
        PRIMARY_LANGUAGE: 'English',
      });
      expect(result).toContain('TestHistorian');
      expect(result).toContain('English');
    });

    it('should leave unmatched placeholders unchanged', () => {
      const result = loadPrompt('historian', {
        HISTORIAN_NAME: 'TestHistorian',
        // PRIMARY_LANGUAGE not provided
      });
      expect(result).toContain('TestHistorian');
      expect(result).toContain('{PRIMARY_LANGUAGE}');
    });

    it('should work without values for prompts without placeholders', () => {
      const result = loadPrompt('curator');
      expect(result.length).toBeGreaterThan(0);
      // Curator prompt has no template placeholders like {PLACEHOLDER_NAME}
      expect(result).toContain('analyzing images');
    });
  });
});
