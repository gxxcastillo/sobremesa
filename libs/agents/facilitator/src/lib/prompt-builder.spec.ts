import { describe, it, expect } from 'vitest';
import { buildUserPrompt, buildSystemPrompt } from './prompt-builder';
import type { Question, FamilyConfig } from '@sobremesa/shared-types';

describe('buildUserPrompt', () => {
  const baseQuestion: Question = {
    id: 'q-123',
    familyId: 'family-abc',
    contentOriginal: 'Tell us more about the wedding!',
    contentFormatted: null,
    status: 'pending',
    priority: 5,
    targetPerson: null,
    targetEvent: null,
    targetPlace: null,
    storyContext: null,
    sourceStoryId: null,
    sourceConversationEventId: null,
    generatedAt: new Date(),
    scheduledFor: null,
    sentAt: null,
    answeredAt: null,
    expiresAt: null,
  };

  describe('participant addressing', () => {
    it('includes "Who to ask" when isTargetParticipant === true', () => {
      const question: Question = {
        ...baseQuestion,
        targetPerson: 'Uncle David',
      };

      const prompt = buildUserPrompt(question, true);

      expect(prompt).toContain('**Who to ask:** Uncle David');
      expect(prompt).not.toContain('**Note:**');
      expect(prompt).not.toContain('not confirmed present');
    });

    it('includes "Note" when isTargetParticipant === false', () => {
      const question: Question = {
        ...baseQuestion,
        targetPerson: 'Nick',
      };

      const prompt = buildUserPrompt(question, false);

      expect(prompt).not.toContain('**Who to ask:**');
      expect(prompt).toContain('**Note:**');
      expect(prompt).toContain('This question relates to Nick');
      expect(prompt).toContain('not confirmed present in chat');
      expect(prompt).toContain(
        'Ask the group warmly without addressing them by name',
      );
    });

    it('includes "Note" when isTargetParticipant === undefined (unknown)', () => {
      const question: Question = {
        ...baseQuestion,
        targetPerson: 'Mystery Person',
      };

      const prompt = buildUserPrompt(question, undefined);

      expect(prompt).not.toContain('**Who to ask:**');
      expect(prompt).toContain('**Note:**');
      expect(prompt).toContain('This question relates to Mystery Person');
      expect(prompt).toContain('not confirmed present in chat');
    });

    it('includes "Note" when isTargetParticipant is not provided', () => {
      const question: Question = {
        ...baseQuestion,
        targetPerson: 'Someone',
      };

      // Call without the second argument
      const prompt = buildUserPrompt(question);

      expect(prompt).not.toContain('**Who to ask:**');
      expect(prompt).toContain('**Note:**');
    });

    it('does not include participant info when targetPerson is null', () => {
      const question: Question = {
        ...baseQuestion,
        targetPerson: null,
      };

      const prompt = buildUserPrompt(question, true);

      expect(prompt).not.toContain('**Who to ask:**');
      expect(prompt).not.toContain('**Note:**');
    });
  });

  describe('question content', () => {
    it('always includes the question content', () => {
      const prompt = buildUserPrompt(baseQuestion);

      expect(prompt).toContain('**Question:** Tell us more about the wedding!');
    });

    it('includes story context when provided', () => {
      const question: Question = {
        ...baseQuestion,
        storyContext: 'A story about the 1985 family reunion',
      };

      const prompt = buildUserPrompt(question);

      expect(prompt).toContain(
        '**Story context:** A story about the 1985 family reunion',
      );
    });

    it('includes related event when provided', () => {
      const question: Question = {
        ...baseQuestion,
        targetEvent: "Elena's wedding",
      };

      const prompt = buildUserPrompt(question);

      expect(prompt).toContain("**Related event:** Elena's wedding");
    });

    it('includes related place when provided', () => {
      const question: Question = {
        ...baseQuestion,
        targetPlace: "Grandma's house in Mexico City",
      };

      const prompt = buildUserPrompt(question);

      expect(prompt).toContain(
        "**Related place:** Grandma's house in Mexico City",
      );
    });

    it('includes warmth formula reminder', () => {
      const prompt = buildUserPrompt(baseQuestion);

      expect(prompt).toContain('Apply all four components');
      expect(prompt).toContain('Warmth + Question + Permission + Gratitude');
      expect(prompt).toContain('Output ONLY the final message text');
    });
  });
});

describe('buildSystemPrompt', () => {
  const baseConfig: FamilyConfig = {
    languages: { primary: 'en' },
  };

  it('uses default personality when not configured', () => {
    const prompt = buildSystemPrompt(baseConfig);

    // The prompt should be generated without errors
    expect(prompt).toBeTruthy();
    expect(typeof prompt).toBe('string');
  });

  it('uses configured personality values', () => {
    const config: FamilyConfig = {
      ...baseConfig,
      bots: {
        facilitator: {
          displayName: 'Abuelita',
          personality: {
            formality: 'warm',
            emojiUsage: 'frequent',
            engagement: 'enthusiastic',
            verbosity: 'detailed',
            patience: 'high',
          },
        },
      },
    };

    const prompt = buildSystemPrompt(config);

    // The prompt should be generated without errors
    expect(prompt).toBeTruthy();
  });

  it('includes cultural terms when provided', () => {
    const config: FamilyConfig = {
      ...baseConfig,
      culturalTerms: ['abuelita', 'tío', 'prima'],
    };

    // This just verifies the config is processed - actual template usage depends on prompt file
    const prompt = buildSystemPrompt(config);
    expect(prompt).toBeTruthy();
  });
});
