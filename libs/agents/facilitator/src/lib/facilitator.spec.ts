import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FacilitatorAgent } from './facilitator';
import type { Question, Family } from '@sobremesa/shared-types';

// Mock the prompts module
vi.mock('@sobremesa/prompts', () => ({
  loadPrompt: vi.fn().mockReturnValue('Mocked system prompt'),
}));

// Mock repositories
const mockQuestionRepo = {
  findByStatus: vi.fn(),
  findPending: vi.fn(),
  markAsked: vi.fn(),
  updateStatus: vi.fn(),
};

const mockFamilyRepo = {
  findById: vi.fn(),
  findAll: vi.fn(),
};

const mockEventLog = {
  log: vi.fn(),
};

const mockFamilyAccessRepo = {
  isPersonParticipant: vi.fn(),
};

const mockPersonRepo = {
  findBestMatch: vi.fn(),
};

const mockLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
};

const mockMessageSender = {
  sendMessage: vi.fn(),
};

const mockProvider = {
  complete: vi.fn(),
};

describe('FacilitatorAgent - Participant Addressing', () => {
  let facilitator: FacilitatorAgent;

  const baseFamily: Family = {
    id: 'family-123',
    name: 'Test Family',
    chatId: 'chat-456',
    config: {
      languages: { primary: 'en' },
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const baseQuestion: Question = {
    id: 'q-789',
    familyId: 'family-123',
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

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset mock implementations
    mockQuestionRepo.findPending.mockResolvedValue([]);
    mockQuestionRepo.findByStatus.mockResolvedValue([]);
    mockQuestionRepo.markAsked.mockResolvedValue(undefined);
    mockQuestionRepo.updateStatus.mockResolvedValue(undefined);
    mockFamilyRepo.findById.mockResolvedValue(baseFamily);
    mockFamilyRepo.findAll.mockResolvedValue([baseFamily]);
    mockEventLog.log.mockResolvedValue(undefined);
    mockMessageSender.sendMessage.mockResolvedValue(12345);
    mockProvider.complete.mockResolvedValue({
      content: 'Warmly formatted question!',
    });

    facilitator = new FacilitatorAgent({
      questionRepo: mockQuestionRepo as any,
      familyRepo: mockFamilyRepo as any,
      eventLog: mockEventLog as any,
      familyAccessRepo: mockFamilyAccessRepo as any,
      personRepo: mockPersonRepo as any,
      messageSender: mockMessageSender as any,
      provider: mockProvider as any,
      model: 'test-model',
      logger: mockLogger as any,
      minMinutesBetweenQuestions: 0, // Disable rate limiting for tests
    });
  });

  describe('when sending a question with targetPerson', () => {
    it('addresses participant directly when verified in chat', async () => {
      const question: Question = {
        ...baseQuestion,
        targetPerson: 'Uncle David',
        status: 'pending',
      };

      // Person exists in family
      mockPersonRepo.findBestMatch.mockResolvedValue({
        person: { id: 'person-david', name: 'David García' },
        confidence: 0.95,
      });

      // Person is a verified participant
      mockFamilyAccessRepo.isPersonParticipant.mockResolvedValue(true);

      mockQuestionRepo.findPending.mockResolvedValue([question]);

      await facilitator.askNextQuestion(baseFamily.id);

      // Verify the AI was called with isTargetParticipant = true
      expect(mockProvider.complete).toHaveBeenCalled();
      const callArgs = mockProvider.complete.mock.calls[0][0];
      const userPrompt = callArgs.messages[0].content;
      expect(userPrompt).toContain('**Who to ask:** Uncle David');
      expect(userPrompt).not.toContain('**Note:**');
    });

    it('asks group when person is NOT a participant', async () => {
      const question: Question = {
        ...baseQuestion,
        targetPerson: 'Nick',
        status: 'pending',
      };

      // Person exists in family
      mockPersonRepo.findBestMatch.mockResolvedValue({
        person: { id: 'person-nick', name: 'Nick' },
        confidence: 0.9,
      });

      // Person is NOT a participant (mentioned in story only)
      mockFamilyAccessRepo.isPersonParticipant.mockResolvedValue(false);

      mockQuestionRepo.findPending.mockResolvedValue([question]);

      await facilitator.askNextQuestion(baseFamily.id);

      // Verify the AI was called with note about not being participant
      expect(mockProvider.complete).toHaveBeenCalled();
      const callArgs = mockProvider.complete.mock.calls[0][0];
      const userPrompt = callArgs.messages[0].content;
      expect(userPrompt).not.toContain('**Who to ask:**');
      expect(userPrompt).toContain('**Note:**');
      expect(userPrompt).toContain('not confirmed present in chat');
    });

    it('asks group when person is not found in family', async () => {
      const question: Question = {
        ...baseQuestion,
        targetPerson: 'Unknown Person',
        status: 'pending',
      };

      // Person does NOT exist in family
      mockPersonRepo.findBestMatch.mockResolvedValue(null);

      mockQuestionRepo.findPending.mockResolvedValue([question]);

      await facilitator.askNextQuestion(baseFamily.id);

      // Should not call isPersonParticipant since person wasn't found
      expect(mockFamilyAccessRepo.isPersonParticipant).not.toHaveBeenCalled();

      // Verify the AI was called with note
      expect(mockProvider.complete).toHaveBeenCalled();
      const callArgs = mockProvider.complete.mock.calls[0][0];
      const userPrompt = callArgs.messages[0].content;
      expect(userPrompt).toContain('**Note:**');
    });

    it('asks group when participant check fails', async () => {
      const question: Question = {
        ...baseQuestion,
        targetPerson: 'Error Person',
        status: 'pending',
      };

      // Person exists
      mockPersonRepo.findBestMatch.mockResolvedValue({
        person: { id: 'person-error', name: 'Error Person' },
        confidence: 0.9,
      });

      // Participant check throws an error
      mockFamilyAccessRepo.isPersonParticipant.mockRejectedValue(
        new Error('Database connection failed'),
      );

      mockQuestionRepo.findPending.mockResolvedValue([question]);

      await facilitator.askNextQuestion(baseFamily.id);

      // Should log warning
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          targetPerson: 'Error Person',
        }),
        expect.stringContaining('Failed to check target participant'),
      );

      // Verify the AI was called with note (fail-safe to group addressing)
      expect(mockProvider.complete).toHaveBeenCalled();
      const callArgs = mockProvider.complete.mock.calls[0][0];
      const userPrompt = callArgs.messages[0].content;
      expect(userPrompt).toContain('**Note:**');
    });
  });

  describe('when sending a question without targetPerson', () => {
    it('does not check participant status', async () => {
      const question: Question = {
        ...baseQuestion,
        targetPerson: null,
        status: 'pending',
      };

      mockQuestionRepo.findPending.mockResolvedValue([question]);

      await facilitator.askNextQuestion(baseFamily.id);

      // Should not call person lookup or participant check
      expect(mockPersonRepo.findBestMatch).not.toHaveBeenCalled();
      expect(mockFamilyAccessRepo.isPersonParticipant).not.toHaveBeenCalled();

      // AI should be called without participant info
      expect(mockProvider.complete).toHaveBeenCalled();
      const callArgs = mockProvider.complete.mock.calls[0][0];
      const userPrompt = callArgs.messages[0].content;
      expect(userPrompt).not.toContain('**Who to ask:**');
      expect(userPrompt).not.toContain('**Note:**');
    });
  });

  describe('when family has no chatId', () => {
    it('does not attempt to send question', async () => {
      const familyNoChatId: Family = {
        ...baseFamily,
        chatId: null,
      };

      const question: Question = {
        ...baseQuestion,
        targetPerson: 'Someone',
        status: 'pending',
      };

      mockFamilyRepo.findById.mockResolvedValue(familyNoChatId);
      mockQuestionRepo.findPending.mockResolvedValue([question]);

      const result = await facilitator.askNextQuestion(familyNoChatId.id);

      // Should skip with reason about no chat ID
      expect(result.success).toBe(false);
      expect(result.skippedReason).toContain('no chat ID');

      // Should not check participant since no chatId
      expect(mockPersonRepo.findBestMatch).not.toHaveBeenCalled();
      expect(mockFamilyAccessRepo.isPersonParticipant).not.toHaveBeenCalled();
    });
  });
});
