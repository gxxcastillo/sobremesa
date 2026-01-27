import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  beforeAll,
  afterAll,
} from 'vitest';
import { InternAgent, DEFAULT_INTERN_CONFIG } from './intern';
import type { Image } from '@sobremesa/shared-types';
import type { AIProvider, AICompletionResponse } from '@sobremesa/ai-provider';

// Mock event repository
const mockEventRepo = {
  findById: vi.fn(),
  findRecent: vi.fn(),
};

// Mock image repository
const mockImageRepo = {
  findRecentInConversation: vi.fn(),
};

// Mock AI provider (replaces mockAnthropic)
const mockProviderComplete = vi.fn();
const mockProvider: AIProvider = {
  name: 'mock',
  complete: mockProviderComplete,
  supportsVision: () => false,
  isAvailable: async () => true,
};

// Helper to create mock AIProvider response
function createMockResponse(
  content: string,
  inputTokens: number,
  outputTokens: number,
): AICompletionResponse {
  return {
    content,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
    model: 'claude-3-5-haiku-20241022',
  };
}

// Mock logger
const mockLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('InternAgent', () => {
  let intern: InternAgent;

  beforeEach(() => {
    vi.clearAllMocks();

    intern = new InternAgent({
      provider: mockProvider,
      model: 'claude-3-5-haiku-20241022',
      eventRepo: mockEventRepo as any,
      imageRepo: mockImageRepo as any,
      logger: mockLogger as any,
    });
  });

  describe('filter()', () => {
    describe('edge cases', () => {
      it('should return relevant=true if event is not found', async () => {
        mockEventRepo.findById.mockResolvedValue(null);

        const result = await intern.filter('event-123', 'family-abc');

        expect(result.relevant).toBe(true);
        expect(result.reason).toContain('not found');
        expect(mockLogger.warn).toHaveBeenCalled();
      });

      it('should return relevant=true for non-message event types', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'photo',
          contentOriginal: 'Photo caption',
        });

        const result = await intern.filter('event-123', 'family-abc');

        expect(result.relevant).toBe(true);
        expect(result.reason).toContain('Non-text event type');
        expect(mockProviderComplete).not.toHaveBeenCalled();
      });

      it('should return relevant=false for empty messages', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: '   ',
        });

        const result = await intern.filter('event-123', 'family-abc');

        expect(result.relevant).toBe(false);
        expect(result.reason).toBe('Empty message');
        expect(mockProviderComplete).not.toHaveBeenCalled();
      });

      it('should return relevant=false for very short messages', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: 'Hi',
        });

        const result = await intern.filter('event-123', 'family-abc');

        expect(result.relevant).toBe(false);
        expect(result.reason).toBe('Message too short');
        expect(mockProviderComplete).not.toHaveBeenCalled();
      });

      it('should return relevant=false for messages with only 2 characters', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: 'OK',
        });

        const result = await intern.filter('event-123', 'family-abc');

        expect(result.relevant).toBe(false);
        expect(result.reason).toBe('Message too short');
      });
    });

    describe('continuation messages (fast path)', () => {
      it('should return relevant=true for messages starting with "and"', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: 'And then she moved to California',
        });

        const result = await intern.filter('event-123', 'family-abc');

        expect(result.relevant).toBe(true);
        expect(result.reason).toBe('Continuation (starts with conjunction)');
        expect(mockProviderComplete).not.toHaveBeenCalled();
      });

      it('should return relevant=true for messages starting with "but"', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: 'But that was before the war',
        });

        const result = await intern.filter('event-123', 'family-abc');

        expect(result.relevant).toBe(true);
        expect(result.reason).toBe('Continuation (starts with conjunction)');
        expect(mockProviderComplete).not.toHaveBeenCalled();
      });

      it('should return relevant=true for messages starting with "or"', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: 'Or maybe it was 1952',
        });

        const result = await intern.filter('event-123', 'family-abc');

        expect(result.relevant).toBe(true);
        expect(result.reason).toBe('Continuation (starts with conjunction)');
        expect(mockProviderComplete).not.toHaveBeenCalled();
      });

      it('should return relevant=true for messages starting with "also"', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: 'Also uncle Bob was there',
          conversationId: 'conv-123',
        });
        mockEventRepo.findRecent.mockResolvedValue([]);

        const result = await intern.filter('event-123', 'family-abc');

        expect(result.relevant).toBe(true);
        expect(result.reason).toBe('Continuation (starts with conjunction)');
        expect(mockProviderComplete).not.toHaveBeenCalled();
      });

      it('should be case-insensitive for conjunction detection', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: 'AND THEN HE LEFT',
        });

        const result = await intern.filter('event-123', 'family-abc');

        expect(result.relevant).toBe(true);
        expect(result.reason).toBe('Continuation (starts with conjunction)');
        expect(mockProviderComplete).not.toHaveBeenCalled();
      });

      it('should not trigger on "and" in the middle of the message', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: 'My grandma and grandpa lived together',
          conversationId: 'conv-123',
        });
        mockEventRepo.findRecent.mockResolvedValue([]);

        mockProviderComplete.mockResolvedValue(
          createMockResponse(
            '{"relevant": true, "reason": "Family history"}',
            100,
            20,
          ),
        );

        const result = await intern.filter('event-123', 'family-abc');

        // Should call LLM since "and" is not at the start
        expect(mockProviderComplete).toHaveBeenCalled();
        expect(result.tokensUsed).toBe(120);
      });
    });

    describe('Haiku API calls', () => {
      beforeEach(() => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: 'My grandmother came from Nicaragua in 1950.',
          conversationId: 'conv-123',
        });
        mockEventRepo.findRecent.mockResolvedValue([]);
      });

      it('should call provider with correct model', async () => {
        mockProviderComplete.mockResolvedValue(
          createMockResponse(
            '{"relevant": true, "reason": "Family history"}',
            100,
            20,
          ),
        );

        await intern.filter('event-123', 'family-abc');

        expect(mockProviderComplete).toHaveBeenCalledWith(
          expect.objectContaining({
            model: 'claude-3-5-haiku-20241022',
            maxTokens: DEFAULT_INTERN_CONFIG.maxTokens,
          }),
        );
      });

      it('should return relevant=true when AI determines message is relevant', async () => {
        mockProviderComplete.mockResolvedValue(
          createMockResponse(
            '{"relevant": true, "reason": "Contains family immigration story"}',
            100,
            20,
          ),
        );

        const result = await intern.filter('event-123', 'family-abc');

        expect(result.relevant).toBe(true);
        expect(result.reason).toBe('Contains family immigration story');
        expect(result.tokensUsed).toBe(120);
      });

      it('should return relevant=false when AI determines message is not relevant', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: 'Good morning everyone!',
          conversationId: 'conv-123',
        });

        mockProviderComplete.mockResolvedValue(
          createMockResponse(
            '{"relevant": false, "reason": "General greeting"}',
            80,
            15,
          ),
        );

        const result = await intern.filter('event-123', 'family-abc');

        expect(result.relevant).toBe(false);
        expect(result.reason).toBe('General greeting');
        expect(result.tokensUsed).toBe(95);
      });

      it('should include recent messages as context', async () => {
        mockEventRepo.findRecent.mockResolvedValue([
          {
            id: 'event-122',
            contentOriginal: 'Previous message',
            actorDisplayName: 'Alice',
          },
          {
            id: 'event-123',
            contentOriginal: 'Current message',
            actorDisplayName: 'Bob',
          },
        ]);

        mockProviderComplete.mockResolvedValue(
          createMockResponse('{"relevant": true, "reason": "test"}', 100, 20),
        );

        await intern.filter('event-123', 'family-abc');

        expect(mockProviderComplete).toHaveBeenCalledWith(
          expect.objectContaining({
            messages: [
              expect.objectContaining({
                content: expect.stringContaining('Alice: "Previous message"'),
              }),
            ],
          }),
        );
      });
    });

    describe('response parsing', () => {
      beforeEach(() => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: 'Some message content here',
          conversationId: 'conv-123',
        });
        mockEventRepo.findRecent.mockResolvedValue([]);
      });

      it('should handle JSON with extra text', async () => {
        mockProviderComplete.mockResolvedValue(
          createMockResponse(
            'Here is my analysis: {"relevant": false, "reason": "Not relevant"}',
            100,
            20,
          ),
        );

        const result = await intern.filter('event-123', 'family-abc');

        expect(result.relevant).toBe(false);
        expect(result.reason).toBe('Not relevant');
      });

      it('should handle invalid JSON response', async () => {
        mockProviderComplete.mockResolvedValue(
          createMockResponse('This is not valid JSON', 100, 20),
        );

        const result = await intern.filter('event-123', 'family-abc');

        expect(result.relevant).toBe(true);
        expect(result.reason).toContain('Could not parse');
      });

      it('should handle malformed JSON', async () => {
        mockProviderComplete.mockResolvedValue(
          createMockResponse('{"relevant": }', 100, 20),
        );

        const result = await intern.filter('event-123', 'family-abc');

        expect(result.relevant).toBe(true);
        expect(result.reason).toContain('parse error');
      });

      it('should default to relevant=true if relevant field is not boolean', async () => {
        mockProviderComplete.mockResolvedValue(
          createMockResponse(
            '{"relevant": "yes", "reason": "Some reason"}',
            100,
            20,
          ),
        );

        const result = await intern.filter('event-123', 'family-abc');

        expect(result.relevant).toBe(true);
      });

      it('should handle missing reason field', async () => {
        mockProviderComplete.mockResolvedValue(
          createMockResponse('{"relevant": true}', 100, 20),
        );

        const result = await intern.filter('event-123', 'family-abc');

        expect(result.relevant).toBe(true);
        expect(result.reason).toBe('No reason provided');
      });
    });

    describe('error handling', () => {
      beforeEach(() => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: 'Some message content here',
          conversationId: 'conv-123',
        });
        mockEventRepo.findRecent.mockResolvedValue([]);
      });

      it('should return relevant=true on API error', async () => {
        mockProviderComplete.mockRejectedValue(
          new Error('API rate limit exceeded'),
        );

        const result = await intern.filter('event-123', 'family-abc');

        expect(result.relevant).toBe(true);
        expect(result.reason).toContain('Filter error');
        expect(result.reason).toContain('API rate limit exceeded');
        expect(mockLogger.error).toHaveBeenCalled();
      });

      it('should return relevant=true on repository error', async () => {
        mockEventRepo.findRecent.mockRejectedValue(
          new Error('Database connection failed'),
        );

        const result = await intern.filter('event-123', 'family-abc');

        expect(result.relevant).toBe(true);
        expect(result.reason).toContain('Filter error');
      });
    });
  });

  describe('route()', () => {
    describe('edge cases', () => {
      it('should return action=scribe if event is not found', async () => {
        mockEventRepo.findById.mockResolvedValue(null);

        const result = await intern.route('event-123', 'family-abc');

        expect(result.action).toBe('scribe');
        expect(result.reason).toContain('not found');
        expect(mockLogger.warn).toHaveBeenCalled();
      });
    });

    describe('command routing (deterministic)', () => {
      it('should route /sobremesa to admin', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: '/sobremesa',
          conversationId: 'conv-123',
        });

        const result = await intern.route('event-123', 'family-abc');

        expect(result.action).toBe('admin');
        expect(result.adminSubtype).toBe('status');
        expect(result.reason).toContain('Command');
        expect(mockProviderComplete).not.toHaveBeenCalled();
      });

      it('should route /status to admin', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: '/status',
          conversationId: 'conv-123',
        });

        const result = await intern.route('event-123', 'family-abc');

        expect(result.action).toBe('admin');
        expect(result.adminSubtype).toBe('status');
        expect(mockProviderComplete).not.toHaveBeenCalled();
      });

      it('should route /sobremesa@botname to admin', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: '/sobremesa@familybot',
          conversationId: 'conv-123',
        });

        const result = await intern.route('event-123', 'family-abc');

        expect(result.action).toBe('admin');
        expect(result.adminSubtype).toBe('status');
      });

      it('should ignore unknown commands', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: '/unknown',
          conversationId: 'conv-123',
        });

        const result = await intern.route('event-123', 'family-abc');

        expect(result.action).toBe('ignore');
        expect(result.reason).toContain('Unknown command');
        expect(mockProviderComplete).not.toHaveBeenCalled();
      });

      it('should be case-insensitive for commands', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: '/STATUS',
          conversationId: 'conv-123',
        });

        const result = await intern.route('event-123', 'family-abc');

        expect(result.action).toBe('admin');
        expect(result.adminSubtype).toBe('status');
      });

      it('should handle commands with arguments', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: '/status show details',
          conversationId: 'conv-123',
        });

        const result = await intern.route('event-123', 'family-abc');

        expect(result.action).toBe('admin');
        expect(result.adminSubtype).toBe('status');
      });
    });

    describe('bot mention routing (deterministic)', () => {
      let internWithBotname: InternAgent;

      beforeEach(() => {
        internWithBotname = new InternAgent({
          provider: mockProvider,
          model: 'claude-3-5-haiku-20241022',
          eventRepo: mockEventRepo as any,
          imageRepo: mockImageRepo as any,
          logger: mockLogger as any,
          config: { botUsername: 'familybot' },
        });
      });

      it('should route bot mention with question to historian', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: '@familybot when was grandma born?',
          conversationId: 'conv-123',
        });

        const result = await internWithBotname.route('event-123', 'family-abc');

        expect(result.action).toBe('historian');
        expect(result.reason).toContain('Question directed at bot');
        expect(mockProviderComplete).not.toHaveBeenCalled();
      });

      it('should route meta question about bot to admin', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: '@familybot are you working?',
          conversationId: 'conv-123',
        });

        const result = await internWithBotname.route('event-123', 'family-abc');

        expect(result.action).toBe('admin');
        expect(result.adminSubtype).toBe('mention');
        expect(result.reason).toContain('Meta question');
        expect(mockProviderComplete).not.toHaveBeenCalled();
      });

      it('should route non-question mention to admin', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: '@familybot thanks for the help',
          conversationId: 'conv-123',
        });

        const result = await internWithBotname.route('event-123', 'family-abc');

        expect(result.action).toBe('admin');
        expect(result.adminSubtype).toBe('mention');
        expect(result.reason).toContain('Bot mentioned');
        expect(mockProviderComplete).not.toHaveBeenCalled();
      });

      it('should not trigger on similar usernames without @', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: 'familybot is cool',
          conversationId: 'conv-123',
        });
        mockEventRepo.findRecent.mockResolvedValue([]);

        mockProviderComplete.mockResolvedValue(
          createMockResponse(
            '{"relevant": true, "reason": "Opinion about bot"}',
            100,
            20,
          ),
        );

        const result = await internWithBotname.route('event-123', 'family-abc');

        // Should go through filter since no @ mention
        expect(mockProviderComplete).toHaveBeenCalled();
        expect(result.action).toBe('scribe');
      });
    });

    describe('private message routing (deterministic)', () => {
      it('should route private messages to admin', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: 'Hello bot',
          conversationId: 'conv-123',
          metadata: { chatType: 'private' },
        });

        const result = await intern.route('event-123', 'family-abc');

        expect(result.action).toBe('admin');
        expect(result.adminSubtype).toBe('dm');
        expect(result.reason).toBe('Private message (DM)');
        expect(mockProviderComplete).not.toHaveBeenCalled();
      });

      it('should not route group messages as private', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: 'Hello everyone',
          conversationId: 'conv-123',
          metadata: { chatType: 'group' },
        });
        mockEventRepo.findRecent.mockResolvedValue([]);

        mockProviderComplete.mockResolvedValue(
          createMockResponse(
            '{"relevant": true, "reason": "Greeting"}',
            100,
            20,
          ),
        );

        const result = await intern.route('event-123', 'family-abc');

        // Should go through filter for group messages
        expect(mockProviderComplete).toHaveBeenCalled();
        expect(result.action).toBe('scribe');
      });
    });

    describe('member event routing (deterministic)', () => {
      it('should route join events to admin', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'join',
          contentOriginal: 'Alice joined the group',
          conversationId: 'conv-123',
        });

        const result = await intern.route('event-123', 'family-abc');

        expect(result.action).toBe('admin');
        expect(result.adminSubtype).toBe('member_event');
        expect(result.reason).toContain('Member event: join');
        expect(mockProviderComplete).not.toHaveBeenCalled();
      });

      it('should route leave events to admin', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'leave',
          contentOriginal: 'Bob left the group',
          conversationId: 'conv-123',
        });

        const result = await intern.route('event-123', 'family-abc');

        expect(result.action).toBe('admin');
        expect(result.adminSubtype).toBe('member_event');
        expect(result.reason).toContain('Member event: leave');
        expect(mockProviderComplete).not.toHaveBeenCalled();
      });
    });

    describe('non-text event routing (deterministic)', () => {
      it('should route photo events to scribe', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'photo',
          contentOriginal: 'Photo caption',
          conversationId: 'conv-123',
        });

        const result = await intern.route('event-123', 'family-abc');

        expect(result.action).toBe('scribe');
        expect(result.reason).toContain('Non-text event type: photo');
        expect(mockProviderComplete).not.toHaveBeenCalled();
      });

      it('should route document events to scribe', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'document',
          contentOriginal: '',
          conversationId: 'conv-123',
        });

        const result = await intern.route('event-123', 'family-abc');

        expect(result.action).toBe('scribe');
        expect(result.reason).toContain('Non-text event type: document');
        expect(mockProviderComplete).not.toHaveBeenCalled();
      });
    });

    describe('AI-based routing (uses filter)', () => {
      beforeEach(() => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: 'My grandmother was born in Nicaragua',
          conversationId: 'conv-123',
        });
        mockEventRepo.findRecent.mockResolvedValue([]);
      });

      it('should route relevant messages to scribe', async () => {
        mockProviderComplete.mockResolvedValue(
          createMockResponse(
            '{"relevant": true, "reason": "Family history content"}',
            100,
            20,
          ),
        );

        const result = await intern.route('event-123', 'family-abc');

        expect(result.action).toBe('scribe');
        expect(result.reason).toBe('Family history content');
        expect(result.tokensUsed).toBe(120);
        expect(mockProviderComplete).toHaveBeenCalled();
      });

      it('should ignore irrelevant messages', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: 'What should I have for lunch?',
          conversationId: 'conv-123',
        });

        mockProviderComplete.mockResolvedValue(
          createMockResponse(
            '{"relevant": false, "reason": "Off-topic question about food"}',
            80,
            15,
          ),
        );

        const result = await intern.route('event-123', 'family-abc');

        expect(result.action).toBe('ignore');
        expect(result.reason).toBe('Off-topic question about food');
        expect(result.tokensUsed).toBe(95);
        expect(mockProviderComplete).toHaveBeenCalled();
      });

      it('should pass language through from filter', async () => {
        mockProviderComplete.mockResolvedValue(
          createMockResponse(
            '{"relevant": true, "reason": "Family story", "language": "es"}',
            100,
            20,
          ),
        );

        const result = await intern.route('event-123', 'family-abc');

        expect(result.action).toBe('scribe');
        expect(result.language).toBe('es');
      });
    });

    describe('routing priority order', () => {
      it('should check commands before bot mentions', async () => {
        const internWithBotname = new InternAgent({
          provider: mockProvider,
          model: 'claude-3-5-haiku-20241022',
          eventRepo: mockEventRepo as any,
          imageRepo: mockImageRepo as any,
          logger: mockLogger as any,
          config: { botUsername: 'familybot' },
        });

        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: '/status @familybot',
          conversationId: 'conv-123',
        });

        const result = await internWithBotname.route('event-123', 'family-abc');

        // Command should take precedence
        expect(result.action).toBe('admin');
        expect(result.adminSubtype).toBe('status');
        expect(result.reason).toContain('Command');
      });

      it('should check bot mentions before private message check', async () => {
        const internWithBotname = new InternAgent({
          provider: mockProvider,
          model: 'claude-3-5-haiku-20241022',
          eventRepo: mockEventRepo as any,
          imageRepo: mockImageRepo as any,
          logger: mockLogger as any,
          config: { botUsername: 'familybot' },
        });

        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: '@familybot hello',
          conversationId: 'conv-123',
          metadata: { chatType: 'private' },
        });

        const result = await internWithBotname.route('event-123', 'family-abc');

        // Bot mention should take precedence over DM
        expect(result.action).toBe('admin');
        expect(result.adminSubtype).toBe('mention');
      });

      it('should check member events before filtering', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'join',
          contentOriginal: 'User joined',
          conversationId: 'conv-123',
        });

        const result = await intern.route('event-123', 'family-abc');

        // Member event should be handled without calling filter
        expect(result.action).toBe('admin');
        expect(mockProviderComplete).not.toHaveBeenCalled();
      });
    });

    describe('error handling', () => {
      it('should return action=scribe when filter has error', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: 'Some message',
          conversationId: 'conv-123',
        });
        mockEventRepo.findRecent.mockRejectedValue(
          new Error('Database connection failed'),
        );

        const result = await intern.route('event-123', 'family-abc');

        // When filter() has an error, it returns relevant=true with "Filter error: ..."
        // route() passes this through and defaults to scribe
        expect(result.action).toBe('scribe');
        expect(result.reason).toContain('Filter error');
        expect(mockLogger.error).toHaveBeenCalled();
      });

      it('should return action=scribe on route error', async () => {
        // Trigger an error in route() itself, not in filter()
        mockEventRepo.findById.mockRejectedValue(
          new Error('Event repository error'),
        );

        const result = await intern.route('event-123', 'family-abc');

        expect(result.action).toBe('scribe');
        expect(result.reason).toContain('Routing error');
        expect(result.reason).toContain('Event repository error');
        expect(mockLogger.error).toHaveBeenCalled();
      });
    });
  });

  describe('linkToImage()', () => {
    describe('edge cases', () => {
      it('should return linked=false if event is not found', async () => {
        mockEventRepo.findById.mockResolvedValue(null);

        const result = await intern.linkToImage('event-123', 'family-abc');

        expect(result.linked).toBe(false);
        expect(result.reason).toContain('not found');
      });

      it('should return linked=false for non-message event types', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'photo',
          contentOriginal: 'Photo caption',
        });

        const result = await intern.linkToImage('event-123', 'family-abc');

        expect(result.linked).toBe(false);
        expect(result.reason).toContain('Non-text event type');
      });

      it('should return linked=false for empty messages', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: '   ',
        });

        const result = await intern.linkToImage('event-123', 'family-abc');

        expect(result.linked).toBe(false);
        expect(result.reason).toBe('Empty message');
      });

      it('should return linked=false if no recent images in conversation', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: 'That photo is beautiful!',
          conversationId: 'conv-123',
        });
        mockImageRepo.findRecentInConversation.mockResolvedValue([]);

        const result = await intern.linkToImage('event-123', 'family-abc');

        expect(result.linked).toBe(false);
        expect(result.reason).toBe('No recent images in conversation');
        expect(mockProviderComplete).not.toHaveBeenCalled();
      });
    });

    describe('Haiku API calls for image linking', () => {
      const mockImage: Image = {
        id: 'img-123',
        familyId: 'family-abc',
        createdAt: new Date(),
        updatedAt: new Date(),
        fileType: 'photo',
        sharedBy: 'Grandma',
        analysis: { description: 'A family gathering' },
        peopleCount: 5,
        estimatedEra: '1960s',
        source: '',
        externalFileId: '',
        visibleText: [],
        connectedStories: [],
        connectedPeople: [],
        conversationEventId: '',
        analyzed: false,
        redacted: false,
      };

      beforeEach(() => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: "That's grandma on the left!",
          conversationId: 'conv-123',
        });
        mockImageRepo.findRecentInConversation.mockResolvedValue([mockImage]);
      });

      it('should call provider for image linking', async () => {
        mockProviderComplete.mockResolvedValue(
          createMockResponse(
            '{"linked": true, "image_id": "img-123", "reference_type": "identifies_people", "reason": "Identifies grandma"}',
            150,
            30,
          ),
        );

        const result = await intern.linkToImage('event-123', 'family-abc');

        expect(mockProviderComplete).toHaveBeenCalled();
        expect(result.linked).toBe(true);
        expect(result.imageId).toBe('img-123');
        expect(result.referenceType).toBe('identifies_people');
        expect(result.tokensUsed).toBe(180);
      });

      it('should include image context in prompt', async () => {
        mockProviderComplete.mockResolvedValue(
          createMockResponse(
            '{"linked": false, "reason": "No reference"}',
            100,
            20,
          ),
        );

        await intern.linkToImage('event-123', 'family-abc');

        expect(mockProviderComplete).toHaveBeenCalledWith(
          expect.objectContaining({
            messages: [
              expect.objectContaining({
                content: expect.stringContaining('img-123'),
              }),
            ],
          }),
        );
      });

      it('should format image with all available metadata', async () => {
        mockProviderComplete.mockResolvedValue(
          createMockResponse('{"linked": false, "reason": "test"}', 100, 20),
        );

        await intern.linkToImage('event-123', 'family-abc');

        const callArgs = mockProviderComplete.mock.calls[0][0];
        const messageContent = callArgs.messages[0].content;

        expect(messageContent).toContain('img-123');
        expect(messageContent).toContain('photo');
        expect(messageContent).toContain('Grandma');
        expect(messageContent).toContain('A family gathering');
        expect(messageContent).toContain('5 people visible');
        expect(messageContent).toContain('1960s');
      });
    });

    describe('reference type detection', () => {
      beforeEach(() => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: 'Some message about the photo',
          conversationId: 'conv-123',
        });
        mockImageRepo.findRecentInConversation.mockResolvedValue([
          { id: 'img-123', familyId: 'family-abc', createdAt: new Date() },
        ]);
      });

      it('should detect describes reference type', async () => {
        mockProviderComplete.mockResolvedValue(
          createMockResponse(
            '{"linked": true, "image_id": "img-123", "reference_type": "describes", "reason": "Describes the scene"}',
            100,
            30,
          ),
        );

        const result = await intern.linkToImage('event-123', 'family-abc');

        expect(result.referenceType).toBe('describes');
      });

      it('should detect identifies_people reference type', async () => {
        mockProviderComplete.mockResolvedValue(
          createMockResponse(
            '{"linked": true, "image_id": "img-123", "reference_type": "identifies_people", "reason": "Names people"}',
            100,
            30,
          ),
        );

        const result = await intern.linkToImage('event-123', 'family-abc');

        expect(result.referenceType).toBe('identifies_people');
      });

      it('should detect provides_context reference type', async () => {
        mockProviderComplete.mockResolvedValue(
          createMockResponse(
            '{"linked": true, "image_id": "img-123", "reference_type": "provides_context", "reason": "Provides date info"}',
            100,
            30,
          ),
        );

        const result = await intern.linkToImage('event-123', 'family-abc');

        expect(result.referenceType).toBe('provides_context');
      });

      it('should detect asks_about reference type', async () => {
        mockProviderComplete.mockResolvedValue(
          createMockResponse(
            '{"linked": true, "image_id": "img-123", "reference_type": "asks_about", "reason": "Asks a question"}',
            100,
            30,
          ),
        );

        const result = await intern.linkToImage('event-123', 'family-abc');

        expect(result.referenceType).toBe('asks_about');
      });

      it('should default to describes for invalid reference type', async () => {
        mockProviderComplete.mockResolvedValue(
          createMockResponse(
            '{"linked": true, "image_id": "img-123", "reference_type": "invalid_type", "reason": "test"}',
            100,
            30,
          ),
        );

        const result = await intern.linkToImage('event-123', 'family-abc');

        expect(result.referenceType).toBe('describes');
      });
    });

    describe('response parsing for image linking', () => {
      beforeEach(() => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: 'Some message',
          conversationId: 'conv-123',
        });
        mockImageRepo.findRecentInConversation.mockResolvedValue([
          { id: 'img-123', familyId: 'family-abc', createdAt: new Date() },
        ]);
      });

      it('should return linked=false when AI says not linked', async () => {
        mockProviderComplete.mockResolvedValue(
          createMockResponse(
            '{"linked": false, "image_id": null, "reference_type": null, "reason": "No image reference"}',
            100,
            20,
          ),
        );

        const result = await intern.linkToImage('event-123', 'family-abc');

        expect(result.linked).toBe(false);
        expect(result.imageId).toBeUndefined();
        expect(result.referenceType).toBeUndefined();
      });

      it('should handle invalid JSON response', async () => {
        mockProviderComplete.mockResolvedValue(
          createMockResponse('Not valid JSON', 100, 20),
        );

        const result = await intern.linkToImage('event-123', 'family-abc');

        expect(result.linked).toBe(false);
        expect(result.reason).toContain('Could not parse');
      });

      it('should handle malformed JSON', async () => {
        mockProviderComplete.mockResolvedValue(
          createMockResponse('{"linked": true, "image_id":}', 100, 20),
        );

        const result = await intern.linkToImage('event-123', 'family-abc');

        expect(result.linked).toBe(false);
        expect(result.reason).toBe('JSON parse error');
      });

      it('should return linked=false if image_id is missing when linked is true', async () => {
        mockProviderComplete.mockResolvedValue(
          createMockResponse(
            '{"linked": true, "reference_type": "describes", "reason": "test"}',
            100,
            20,
          ),
        );

        const result = await intern.linkToImage('event-123', 'family-abc');

        expect(result.linked).toBe(false);
        expect(result.reason).toBe('No image ID in response');
      });

      it('should handle JSON with extra text around it', async () => {
        mockProviderComplete.mockResolvedValue(
          createMockResponse(
            'Here is my analysis:\n{"linked": true, "image_id": "img-123", "reference_type": "describes", "reason": "test"}\nThank you!',
            100,
            30,
          ),
        );

        const result = await intern.linkToImage('event-123', 'family-abc');

        expect(result.linked).toBe(true);
        expect(result.imageId).toBe('img-123');
      });
    });

    describe('error handling for image linking', () => {
      beforeEach(() => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: 'Some message',
          conversationId: 'conv-123',
        });
        mockImageRepo.findRecentInConversation.mockResolvedValue([
          { id: 'img-123', familyId: 'family-abc', createdAt: new Date() },
        ]);
      });

      it('should return linked=false on API error', async () => {
        mockProviderComplete.mockRejectedValue(new Error('API timeout'));

        const result = await intern.linkToImage('event-123', 'family-abc');

        expect(result.linked).toBe(false);
        expect(result.reason).toContain('Error');
        expect(result.reason).toContain('API timeout');
        expect(mockLogger.error).toHaveBeenCalled();
      });

      it('should return linked=false on repository error', async () => {
        mockImageRepo.findRecentInConversation.mockRejectedValue(
          new Error('DB error'),
        );

        const result = await intern.linkToImage('event-123', 'family-abc');

        expect(result.linked).toBe(false);
        expect(result.reason).toContain('Error');
      });
    });
  });

  describe('configuration', () => {
    const previousEnv = {
      SUPABASE_URL: process.env['SUPABASE_URL'],
      SUPABASE_ANON_KEY: process.env['SUPABASE_ANON_KEY'],
      SUPABASE_SERVICE_ROLE_KEY: process.env['SUPABASE_SERVICE_ROLE_KEY'],
    };

    beforeAll(() =>
      Object.assign(process.env, {
        SUPABASE_URL: 'http://localhost:54321',
        SUPABASE_ANON_KEY: 'test-anon-key-placeholder',
        SUPABASE_SERVICE_ROLE_KEY: 'test-secret-key-placeholder',
      }),
    );

    afterAll(() => {
      Object.assign(process.env, previousEnv);
    });

    it('should use default configuration', () => {
      const agent = new InternAgent({
        provider: mockProvider,
        model: 'claude-3-5-haiku-20241022',
      });

      expect(agent).toBeDefined();
    });

    it('should allow custom configuration overrides', async () => {
      const customIntern = new InternAgent({
        provider: mockProvider,
        model: 'claude-3-haiku-20240307',
        eventRepo: mockEventRepo as any,
        imageRepo: mockImageRepo as any,
        config: {
          maxTokens: 50,
        },
      });

      mockEventRepo.findById.mockResolvedValue({
        id: 'event-123',
        eventType: 'message',
        contentOriginal: 'Some longer message here',
        conversationId: 'conv-123',
      });
      mockEventRepo.findRecent.mockResolvedValue([]);
      mockProviderComplete.mockResolvedValue(
        createMockResponse('{"relevant": true, "reason": "test"}', 100, 20),
      );

      await customIntern.filter('event-123', 'family-abc');

      expect(mockProviderComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-3-haiku-20240307',
          maxTokens: 50,
        }),
      );
    });
  });

  describe('logging', () => {
    beforeEach(() => {
      mockEventRepo.findById.mockResolvedValue({
        id: 'event-123',
        eventType: 'message',
        contentOriginal: 'Some message content here for testing',
        conversationId: 'conv-123',
      });
      mockEventRepo.findRecent.mockResolvedValue([]);
    });

    it('should log debug info for filter results', async () => {
      mockProviderComplete.mockResolvedValue(
        createMockResponse(
          '{"relevant": true, "reason": "Family story"}',
          100,
          20,
        ),
      );

      await intern.filter('event-123', 'family-abc');

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'event-123',
          relevant: true,
          tokensUsed: 120,
        }),
        'Filter result',
      );
    });

    it('should log debug info for image link results', async () => {
      mockImageRepo.findRecentInConversation.mockResolvedValue([
        { id: 'img-123', familyId: 'family-abc', createdAt: new Date() },
      ]);
      mockProviderComplete.mockResolvedValue(
        createMockResponse(
          '{"linked": true, "image_id": "img-123", "reference_type": "describes", "reason": "test"}',
          100,
          30,
        ),
      );

      await intern.linkToImage('event-123', 'family-abc');

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'event-123',
          linked: true,
          imageId: 'img-123',
        }),
        'Image link result',
      );
    });
  });
});
