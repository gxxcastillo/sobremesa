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

// Mock event repository
const mockEventRepo = {
  findById: vi.fn(),
  findRecent: vi.fn(),
};

// Mock image repository
const mockImageRepo = {
  findRecentInConversation: vi.fn(),
};

// Mock Anthropic client
const mockAnthropicCreate = vi.fn();
const mockAnthropic = {
  messages: {
    create: mockAnthropicCreate,
  },
};

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
      anthropic: mockAnthropic,
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
        expect(mockAnthropicCreate).not.toHaveBeenCalled();
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
        expect(mockAnthropicCreate).not.toHaveBeenCalled();
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
        expect(mockAnthropicCreate).not.toHaveBeenCalled();
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

      it('should call Anthropic with correct model', async () => {
        mockAnthropicCreate.mockResolvedValue({
          content: [
            {
              type: 'text',
              text: '{"relevant": true, "reason": "Family history"}',
            },
          ],
          usage: { input_tokens: 100, output_tokens: 20 },
        });

        await intern.filter('event-123', 'family-abc');

        expect(mockAnthropicCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            model: DEFAULT_INTERN_CONFIG.model,
            max_tokens: DEFAULT_INTERN_CONFIG.maxTokens,
          }),
        );
      });

      it('should return relevant=true when Haiku determines message is relevant', async () => {
        mockAnthropicCreate.mockResolvedValue({
          content: [
            {
              type: 'text',
              text: '{"relevant": true, "reason": "Contains family immigration story"}',
            },
          ],
          usage: { input_tokens: 100, output_tokens: 20 },
        });

        const result = await intern.filter('event-123', 'family-abc');

        expect(result.relevant).toBe(true);
        expect(result.reason).toBe('Contains family immigration story');
        expect(result.tokensUsed).toBe(120);
      });

      it('should return relevant=false when Haiku determines message is not relevant', async () => {
        mockEventRepo.findById.mockResolvedValue({
          id: 'event-123',
          eventType: 'message',
          contentOriginal: 'Good morning everyone!',
          conversationId: 'conv-123',
        });

        mockAnthropicCreate.mockResolvedValue({
          content: [
            {
              type: 'text',
              text: '{"relevant": false, "reason": "General greeting"}',
            },
          ],
          usage: { input_tokens: 80, output_tokens: 15 },
        });

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

        mockAnthropicCreate.mockResolvedValue({
          content: [
            { type: 'text', text: '{"relevant": true, "reason": "test"}' },
          ],
          usage: { input_tokens: 100, output_tokens: 20 },
        });

        await intern.filter('event-123', 'family-abc');

        expect(mockAnthropicCreate).toHaveBeenCalledWith(
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

      it('should handle non-text response type', async () => {
        mockAnthropicCreate.mockResolvedValue({
          content: [{ type: 'image', data: 'some-data' }],
          usage: { input_tokens: 100, output_tokens: 0 },
        });

        const result = await intern.filter('event-123', 'family-abc');

        expect(result.relevant).toBe(true);
        expect(result.reason).toBe('Unexpected response type');
      });

      it('should handle JSON with extra text', async () => {
        mockAnthropicCreate.mockResolvedValue({
          content: [
            {
              type: 'text',
              text: 'Here is my analysis: {"relevant": false, "reason": "Not relevant"}',
            },
          ],
          usage: { input_tokens: 100, output_tokens: 20 },
        });

        const result = await intern.filter('event-123', 'family-abc');

        expect(result.relevant).toBe(false);
        expect(result.reason).toBe('Not relevant');
      });

      it('should handle invalid JSON response', async () => {
        mockAnthropicCreate.mockResolvedValue({
          content: [{ type: 'text', text: 'This is not valid JSON' }],
          usage: { input_tokens: 100, output_tokens: 20 },
        });

        const result = await intern.filter('event-123', 'family-abc');

        expect(result.relevant).toBe(true);
        expect(result.reason).toContain('Could not parse');
      });

      it('should handle malformed JSON', async () => {
        mockAnthropicCreate.mockResolvedValue({
          content: [{ type: 'text', text: '{"relevant": }' }],
          usage: { input_tokens: 100, output_tokens: 20 },
        });

        const result = await intern.filter('event-123', 'family-abc');

        expect(result.relevant).toBe(true);
        expect(result.reason).toContain('parse error');
      });

      it('should default to relevant=true if relevant field is not boolean', async () => {
        mockAnthropicCreate.mockResolvedValue({
          content: [
            {
              type: 'text',
              text: '{"relevant": "yes", "reason": "Some reason"}',
            },
          ],
          usage: { input_tokens: 100, output_tokens: 20 },
        });

        const result = await intern.filter('event-123', 'family-abc');

        expect(result.relevant).toBe(true);
      });

      it('should handle missing reason field', async () => {
        mockAnthropicCreate.mockResolvedValue({
          content: [{ type: 'text', text: '{"relevant": true}' }],
          usage: { input_tokens: 100, output_tokens: 20 },
        });

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
        mockAnthropicCreate.mockRejectedValue(
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
        expect(mockAnthropicCreate).not.toHaveBeenCalled();
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
        sourceEventId: '',
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

      it('should call Anthropic for image linking', async () => {
        mockAnthropicCreate.mockResolvedValue({
          content: [
            {
              type: 'text',
              text: '{"linked": true, "image_id": "img-123", "reference_type": "identifies_people", "reason": "Identifies grandma"}',
            },
          ],
          usage: { input_tokens: 150, output_tokens: 30 },
        });

        const result = await intern.linkToImage('event-123', 'family-abc');

        expect(mockAnthropicCreate).toHaveBeenCalled();
        expect(result.linked).toBe(true);
        expect(result.imageId).toBe('img-123');
        expect(result.referenceType).toBe('identifies_people');
        expect(result.tokensUsed).toBe(180);
      });

      it('should include image context in prompt', async () => {
        mockAnthropicCreate.mockResolvedValue({
          content: [
            {
              type: 'text',
              text: '{"linked": false, "reason": "No reference"}',
            },
          ],
          usage: { input_tokens: 100, output_tokens: 20 },
        });

        await intern.linkToImage('event-123', 'family-abc');

        expect(mockAnthropicCreate).toHaveBeenCalledWith(
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
        mockAnthropicCreate.mockResolvedValue({
          content: [
            { type: 'text', text: '{"linked": false, "reason": "test"}' },
          ],
          usage: { input_tokens: 100, output_tokens: 20 },
        });

        await intern.linkToImage('event-123', 'family-abc');

        const callArgs = mockAnthropicCreate.mock.calls[0][0];
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
        mockAnthropicCreate.mockResolvedValue({
          content: [
            {
              type: 'text',
              text: '{"linked": true, "image_id": "img-123", "reference_type": "describes", "reason": "Describes the scene"}',
            },
          ],
          usage: { input_tokens: 100, output_tokens: 30 },
        });

        const result = await intern.linkToImage('event-123', 'family-abc');

        expect(result.referenceType).toBe('describes');
      });

      it('should detect identifies_people reference type', async () => {
        mockAnthropicCreate.mockResolvedValue({
          content: [
            {
              type: 'text',
              text: '{"linked": true, "image_id": "img-123", "reference_type": "identifies_people", "reason": "Names people"}',
            },
          ],
          usage: { input_tokens: 100, output_tokens: 30 },
        });

        const result = await intern.linkToImage('event-123', 'family-abc');

        expect(result.referenceType).toBe('identifies_people');
      });

      it('should detect provides_context reference type', async () => {
        mockAnthropicCreate.mockResolvedValue({
          content: [
            {
              type: 'text',
              text: '{"linked": true, "image_id": "img-123", "reference_type": "provides_context", "reason": "Provides date info"}',
            },
          ],
          usage: { input_tokens: 100, output_tokens: 30 },
        });

        const result = await intern.linkToImage('event-123', 'family-abc');

        expect(result.referenceType).toBe('provides_context');
      });

      it('should detect asks_about reference type', async () => {
        mockAnthropicCreate.mockResolvedValue({
          content: [
            {
              type: 'text',
              text: '{"linked": true, "image_id": "img-123", "reference_type": "asks_about", "reason": "Asks a question"}',
            },
          ],
          usage: { input_tokens: 100, output_tokens: 30 },
        });

        const result = await intern.linkToImage('event-123', 'family-abc');

        expect(result.referenceType).toBe('asks_about');
      });

      it('should default to describes for invalid reference type', async () => {
        mockAnthropicCreate.mockResolvedValue({
          content: [
            {
              type: 'text',
              text: '{"linked": true, "image_id": "img-123", "reference_type": "invalid_type", "reason": "test"}',
            },
          ],
          usage: { input_tokens: 100, output_tokens: 30 },
        });

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

      it('should return linked=false when Haiku says not linked', async () => {
        mockAnthropicCreate.mockResolvedValue({
          content: [
            {
              type: 'text',
              text: '{"linked": false, "image_id": null, "reference_type": null, "reason": "No image reference"}',
            },
          ],
          usage: { input_tokens: 100, output_tokens: 20 },
        });

        const result = await intern.linkToImage('event-123', 'family-abc');

        expect(result.linked).toBe(false);
        expect(result.imageId).toBeUndefined();
        expect(result.referenceType).toBeUndefined();
      });

      it('should handle non-text response type', async () => {
        mockAnthropicCreate.mockResolvedValue({
          content: [{ type: 'image', data: 'some-data' }],
          usage: { input_tokens: 100, output_tokens: 0 },
        });

        const result = await intern.linkToImage('event-123', 'family-abc');

        expect(result.linked).toBe(false);
        expect(result.reason).toBe('Unexpected response type');
      });

      it('should handle invalid JSON response', async () => {
        mockAnthropicCreate.mockResolvedValue({
          content: [{ type: 'text', text: 'Not valid JSON' }],
          usage: { input_tokens: 100, output_tokens: 20 },
        });

        const result = await intern.linkToImage('event-123', 'family-abc');

        expect(result.linked).toBe(false);
        expect(result.reason).toContain('Could not parse');
      });

      it('should handle malformed JSON', async () => {
        mockAnthropicCreate.mockResolvedValue({
          content: [{ type: 'text', text: '{"linked": true, "image_id":}' }],
          usage: { input_tokens: 100, output_tokens: 20 },
        });

        const result = await intern.linkToImage('event-123', 'family-abc');

        expect(result.linked).toBe(false);
        expect(result.reason).toBe('JSON parse error');
      });

      it('should return linked=false if image_id is missing when linked is true', async () => {
        mockAnthropicCreate.mockResolvedValue({
          content: [
            {
              type: 'text',
              text: '{"linked": true, "reference_type": "describes", "reason": "test"}',
            },
          ],
          usage: { input_tokens: 100, output_tokens: 20 },
        });

        const result = await intern.linkToImage('event-123', 'family-abc');

        expect(result.linked).toBe(false);
        expect(result.reason).toBe('No image ID in response');
      });

      it('should handle JSON with extra text around it', async () => {
        mockAnthropicCreate.mockResolvedValue({
          content: [
            {
              type: 'text',
              text: 'Here is my analysis:\n{"linked": true, "image_id": "img-123", "reference_type": "describes", "reason": "test"}\nThank you!',
            },
          ],
          usage: { input_tokens: 100, output_tokens: 30 },
        });

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
        mockAnthropicCreate.mockRejectedValue(new Error('API timeout'));

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
        anthropic: mockAnthropic,
      });

      expect(agent).toBeDefined();
    });

    it('should allow custom configuration overrides', async () => {
      const customIntern = new InternAgent({
        anthropic: mockAnthropic,
        eventRepo: mockEventRepo as any,
        imageRepo: mockImageRepo as any,
        config: {
          model: 'claude-3-haiku-20240307',
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
      mockAnthropicCreate.mockResolvedValue({
        content: [
          { type: 'text', text: '{"relevant": true, "reason": "test"}' },
        ],
        usage: { input_tokens: 100, output_tokens: 20 },
      });

      await customIntern.filter('event-123', 'family-abc');

      expect(mockAnthropicCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-3-haiku-20240307',
          max_tokens: 50,
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
      mockAnthropicCreate.mockResolvedValue({
        content: [
          {
            type: 'text',
            text: '{"relevant": true, "reason": "Family story"}',
          },
        ],
        usage: { input_tokens: 100, output_tokens: 20 },
      });

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
      mockAnthropicCreate.mockResolvedValue({
        content: [
          {
            type: 'text',
            text: '{"linked": true, "image_id": "img-123", "reference_type": "describes", "reason": "test"}',
          },
        ],
        usage: { input_tokens: 100, output_tokens: 30 },
      });

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
