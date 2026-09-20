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
  findMostRecentAskedAt: vi.fn(),
  findPending: vi.fn(),
  findExpiredPending: vi.fn(),
  markAsked: vi.fn(),
  updateStatus: vi.fn(),
  retire: vi.fn(),
};

const mockFamilyRepo = {
  findById: vi.fn(),
  findAll: vi.fn(),
  findAllActive: vi.fn(),
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

const mockConversationEventRepo = {
  findMostRecentOccurredAt: vi.fn(),
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
    mockQuestionRepo.findMostRecentAskedAt.mockResolvedValue(null);
    mockQuestionRepo.findExpiredPending.mockResolvedValue([]);
    mockQuestionRepo.markAsked.mockResolvedValue(undefined);
    mockQuestionRepo.updateStatus.mockResolvedValue(undefined);
    mockQuestionRepo.retire.mockResolvedValue(undefined);
    mockFamilyRepo.findById.mockResolvedValue(baseFamily);
    mockFamilyRepo.findAll.mockResolvedValue([baseFamily]);
    mockFamilyRepo.findAllActive.mockResolvedValue([baseFamily]);
    mockEventLog.log.mockResolvedValue(undefined);
    mockMessageSender.sendMessage.mockResolvedValue({
      status: 'sent',
      messageId: 12345,
    });
    mockProvider.complete.mockResolvedValue({
      content: 'Warmly formatted question!',
    });
    // No activity ever recorded -- nothing for a follow-up quiet check to
    // wait on, unless a test says otherwise.
    mockConversationEventRepo.findMostRecentOccurredAt.mockResolvedValue(null);

    facilitator = new FacilitatorAgent({
      questionRepo: mockQuestionRepo as any,
      familyRepo: mockFamilyRepo as any,
      eventLog: mockEventLog as any,
      familyAccessRepo: mockFamilyAccessRepo as any,
      personRepo: mockPersonRepo as any,
      conversationEventRepo: mockConversationEventRepo as any,
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

  describe('ask-rate throttle', () => {
    let throttledFacilitator: FacilitatorAgent;

    beforeEach(() => {
      throttledFacilitator = new FacilitatorAgent({
        questionRepo: mockQuestionRepo as any,
        familyRepo: mockFamilyRepo as any,
        eventLog: mockEventLog as any,
        familyAccessRepo: mockFamilyAccessRepo as any,
        personRepo: mockPersonRepo as any,
        conversationEventRepo: mockConversationEventRepo as any,
        messageSender: mockMessageSender as any,
        provider: mockProvider as any,
        model: 'test-model',
        logger: mockLogger as any,
        minMinutesBetweenQuestions: 60,
      });
    });

    const minutesAgo = (minutes: number): Date =>
      new Date(Date.now() - minutes * 60 * 1000);

    it('throttles on an answered question asked 10 minutes ago (regression)', async () => {
      mockQuestionRepo.findMostRecentAskedAt.mockResolvedValue(minutesAgo(10));
      mockQuestionRepo.findPending.mockResolvedValue([baseQuestion]);

      const result = await throttledFacilitator.askNextQuestion(baseFamily.id);

      expect(result.skippedReason).toContain(
        'Question asked within last 60 minutes',
      );
      expect(mockMessageSender.sendMessage).not.toHaveBeenCalled();
    });

    it('does not throttle when no question has ever been asked', async () => {
      mockQuestionRepo.findMostRecentAskedAt.mockResolvedValue(null);
      mockQuestionRepo.findPending.mockResolvedValue([baseQuestion]);

      const result = await throttledFacilitator.askNextQuestion(baseFamily.id);

      expect(result.skippedReason).toBeUndefined();
      expect(mockMessageSender.sendMessage).toHaveBeenCalled();
    });

    it('throttles just inside the interval', async () => {
      mockQuestionRepo.findMostRecentAskedAt.mockResolvedValue(minutesAgo(59));
      mockQuestionRepo.findPending.mockResolvedValue([baseQuestion]);

      const result = await throttledFacilitator.askNextQuestion(baseFamily.id);

      expect(result.skippedReason).toContain(
        'Question asked within last 60 minutes',
      );
      expect(mockMessageSender.sendMessage).not.toHaveBeenCalled();
    });

    it('does not throttle just outside the interval', async () => {
      mockQuestionRepo.findMostRecentAskedAt.mockResolvedValue(minutesAgo(61));
      mockQuestionRepo.findPending.mockResolvedValue([baseQuestion]);

      const result = await throttledFacilitator.askNextQuestion(baseFamily.id);

      expect(result.skippedReason).toBeUndefined();
      expect(mockMessageSender.sendMessage).toHaveBeenCalled();
    });
  });

  describe('persona name stamped when marking a question asked', () => {
    it('defaults to Carmencita when the family has not customized the persona', async () => {
      mockQuestionRepo.findPending.mockResolvedValue([baseQuestion]);

      await facilitator.askNextQuestion(baseFamily.id);

      expect(mockQuestionRepo.markAsked).toHaveBeenCalledWith(
        baseFamily.id,
        baseQuestion.id,
        undefined,
        12345,
        'Carmencita',
      );
    });

    it('uses the family-configured display name when set', async () => {
      const customFamily: Family = {
        ...baseFamily,
        config: {
          ...baseFamily.config,
          bots: { facilitator: { displayName: 'Abuelita' } },
        },
      };
      mockFamilyRepo.findById.mockResolvedValue(customFamily);
      mockQuestionRepo.findPending.mockResolvedValue([baseQuestion]);

      await facilitator.askNextQuestion(customFamily.id);

      expect(mockQuestionRepo.markAsked).toHaveBeenCalledWith(
        customFamily.id,
        baseQuestion.id,
        undefined,
        12345,
        'Abuelita',
      );
    });
  });

  describe('outbound-send-reliability-plan.md #3 -- dedup keys', () => {
    it('claims a dedup key scoped to the question id when asking', async () => {
      mockQuestionRepo.findPending.mockResolvedValue([baseQuestion]);

      await facilitator.askNextQuestion(baseFamily.id);

      const [, , options] = mockMessageSender.sendMessage.mock.calls[0];
      expect(options.dedup).toEqual({
        familyId: baseFamily.id,
        key: `facilitator:question:${baseQuestion.id}`,
        questionId: baseQuestion.id,
      });
    });

    it('uses the same dedup key on a retried nudge for the same question (still proposed)', async () => {
      mockQuestionRepo.findPending.mockResolvedValue([baseQuestion]);

      await facilitator.askNextQuestion(baseFamily.id);
      await facilitator.askNextQuestion(baseFamily.id);

      const keys = mockMessageSender.sendMessage.mock.calls.map(
        (call: any[]) => call[2]?.dedup?.key,
      );
      expect(keys).toEqual([
        `facilitator:question:${baseQuestion.id}`,
        `facilitator:question:${baseQuestion.id}`,
      ]);
    });

    it('sweep/nudge overlap: two concurrent triggers for the same family claim the same dedup key', async () => {
      mockQuestionRepo.findPending.mockResolvedValue([baseQuestion]);

      await Promise.all([
        facilitator.askNextQuestion(baseFamily.id),
        facilitator.askNextQuestion(baseFamily.id),
      ]);

      const keys = mockMessageSender.sendMessage.mock.calls.map(
        (call: any[]) => call[2]?.dedup?.key,
      );
      expect(keys).toEqual([
        `facilitator:question:${baseQuestion.id}`,
        `facilitator:question:${baseQuestion.id}`,
      ]);
      // The real collision handling (only one actually reaches Telegram) is
      // BotManager's job, covered in bot-manager.spec.ts -- this only pins
      // that both triggers present the ledger with the same key to collide
      // on.
    });

    it('FM6 self-heal: a "duplicate" outcome (send succeeded, markAsked failed last time) still marks the question asked with the recovered message id', async () => {
      mockMessageSender.sendMessage.mockResolvedValue({
        status: 'duplicate',
        messageId: 555,
      });
      mockQuestionRepo.findPending.mockResolvedValue([baseQuestion]);

      await facilitator.askNextQuestion(baseFamily.id);

      expect(mockQuestionRepo.markAsked).toHaveBeenCalledWith(
        baseFamily.id,
        baseQuestion.id,
        undefined,
        555,
        'Carmencita',
      );
    });

    it('an "unconfirmed" outcome still marks the question asked, with no recorded message id (lost-over-duplicate policy: never resend an ambiguous send)', async () => {
      mockMessageSender.sendMessage.mockResolvedValue({
        status: 'unconfirmed',
      });
      mockQuestionRepo.findPending.mockResolvedValue([baseQuestion]);

      await facilitator.askNextQuestion(baseFamily.id);

      expect(mockQuestionRepo.markAsked).toHaveBeenCalledWith(
        baseFamily.id,
        baseQuestion.id,
        undefined,
        undefined,
        'Carmencita',
      );
    });

    describe('sendResponse (Historian answer)', () => {
      it('claims a dedup key scoped to the question conversation event', async () => {
        const result = await facilitator.sendResponse({
          familyId: baseFamily.id,
          originalQuestion: 'What was grandma like?',
          historianAnswer: 'She was warm and funny.',
          chatId: baseFamily.chatId as string,
          conversationEventId: 'evt-1',
        });

        expect(result.success).toBe(true);
        const [, , options] = mockMessageSender.sendMessage.mock.calls[0];
        expect(options.dedup).toEqual({
          familyId: baseFamily.id,
          key: 'historian-answer:evt-1',
          conversationEventId: 'evt-1',
        });
      });

      it('uses the same dedup key on a retried pass even though the reworded answer differs', async () => {
        await facilitator.sendResponse({
          familyId: baseFamily.id,
          originalQuestion: 'What was grandma like?',
          historianAnswer: 'She was warm and funny.',
          chatId: baseFamily.chatId as string,
          conversationEventId: 'evt-1',
        });
        await facilitator.sendResponse({
          familyId: baseFamily.id,
          originalQuestion: 'What was grandma like?',
          historianAnswer: 'She loved to laugh and tell stories.',
          chatId: baseFamily.chatId as string,
          conversationEventId: 'evt-1',
        });

        const keys = mockMessageSender.sendMessage.mock.calls.map(
          (call: any[]) => call[2]?.dedup?.key,
        );
        expect(keys).toEqual([
          'historian-answer:evt-1',
          'historian-answer:evt-1',
        ]);
      });

      it('retried historian event that already reached "sent" reports success with no second real send', async () => {
        // BotManager's ledger is what actually prevents the second Telegram
        // call (bot-manager.spec.ts); here we simulate its outcome for an
        // already-delivered dedup key and assert the caller treats it as
        // success, never as a failure to retry.
        mockMessageSender.sendMessage.mockResolvedValue({
          status: 'duplicate',
          messageId: 111,
        });

        const result = await facilitator.sendResponse({
          familyId: baseFamily.id,
          originalQuestion: 'q',
          historianAnswer: 'a',
          chatId: baseFamily.chatId as string,
          conversationEventId: 'evt-2',
        });

        expect(result.success).toBe(true);
        expect(mockMessageSender.sendMessage).toHaveBeenCalledTimes(1);
      });

      it('an ambiguous ("unconfirmed") outcome still reports success and logs, never resending', async () => {
        mockMessageSender.sendMessage.mockResolvedValue({
          status: 'unconfirmed',
        });

        const result = await facilitator.sendResponse({
          familyId: baseFamily.id,
          originalQuestion: 'q',
          historianAnswer: 'a',
          chatId: baseFamily.chatId as string,
          conversationEventId: 'evt-3',
        });

        expect(result.success).toBe(true);
        expect(mockEventLog.log).toHaveBeenCalled();
      });
    });
  });

  describe('story-followups-plan.md #5', () => {
    const followupQuestion: Question = {
      id: 'q-followup-1',
      familyId: baseFamily.id,
      contentOriginal: '¿Cómo eligieron el nombre?',
      languageOriginal: 'es',
      origin: 'followup',
      status: 'proposed',
      priority: 50,
      sourceMessageId: 'event-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    describe('retiring expired questions', () => {
      it('retires every expired pending question and logs question_retired before asking', async () => {
        const expired: Question = {
          ...followupQuestion,
          id: 'q-expired-1',
        };
        mockQuestionRepo.findExpiredPending.mockResolvedValue([expired]);
        mockQuestionRepo.findPending.mockResolvedValue([]);

        await facilitator.askNextQuestion(baseFamily.id);

        expect(mockQuestionRepo.findExpiredPending).toHaveBeenCalledWith(
          baseFamily.id,
        );
        expect(mockQuestionRepo.retire).toHaveBeenCalledWith(
          baseFamily.id,
          'q-expired-1',
        );
        expect(mockEventLog.log).toHaveBeenCalledWith(
          expect.objectContaining({
            familyId: baseFamily.id,
            eventType: 'question_retired',
            conversationEventId: expired.sourceMessageId,
            eventData: { questionId: 'q-expired-1', reason: 'expired' },
          }),
        );
      });

      it('retires every expired question, not just the first', async () => {
        mockQuestionRepo.findExpiredPending.mockResolvedValue([
          { ...followupQuestion, id: 'q-expired-1' },
          { ...followupQuestion, id: 'q-expired-2' },
        ]);
        mockQuestionRepo.findPending.mockResolvedValue([]);

        await facilitator.askNextQuestion(baseFamily.id);

        expect(mockQuestionRepo.retire).toHaveBeenCalledTimes(2);
        expect(mockQuestionRepo.retire).toHaveBeenCalledWith(
          baseFamily.id,
          'q-expired-1',
        );
        expect(mockQuestionRepo.retire).toHaveBeenCalledWith(
          baseFamily.id,
          'q-expired-2',
        );
      });

      it('does nothing when there is nothing expired', async () => {
        mockQuestionRepo.findExpiredPending.mockResolvedValue([]);
        mockQuestionRepo.findPending.mockResolvedValue([baseQuestion]);

        await facilitator.askNextQuestion(baseFamily.id);

        expect(mockQuestionRepo.retire).not.toHaveBeenCalled();
      });
    });

    describe('follow-up quiet check (D2)', () => {
      it('asks a follow-up once the chat has been quiet for 30+ minutes', async () => {
        mockQuestionRepo.findPending.mockResolvedValue([followupQuestion]);
        mockConversationEventRepo.findMostRecentOccurredAt.mockResolvedValue(
          new Date(Date.now() - 31 * 60 * 1000),
        );

        const result = await facilitator.askNextQuestion(baseFamily.id);

        expect(result.success).toBe(true);
        expect(result.questionId).toBe(followupQuestion.id);
        expect(mockMessageSender.sendMessage).toHaveBeenCalled();
      });

      it('skips a follow-up while the chat is still active, without sending', async () => {
        mockQuestionRepo.findPending.mockResolvedValue([followupQuestion]);
        mockConversationEventRepo.findMostRecentOccurredAt.mockResolvedValue(
          new Date(Date.now() - 5 * 60 * 1000),
        );

        const result = await facilitator.askNextQuestion(baseFamily.id);

        expect(result.success).toBe(true);
        expect(result.skippedReason).toContain('quiet');
        expect(mockMessageSender.sendMessage).not.toHaveBeenCalled();
        expect(mockQuestionRepo.markAsked).not.toHaveBeenCalled();
      });

      it('asks a follow-up immediately when the family has no recorded activity at all', async () => {
        mockQuestionRepo.findPending.mockResolvedValue([followupQuestion]);
        mockConversationEventRepo.findMostRecentOccurredAt.mockResolvedValue(
          null,
        );

        const result = await facilitator.askNextQuestion(baseFamily.id);

        expect(result.success).toBe(true);
        expect(mockMessageSender.sendMessage).toHaveBeenCalled();
      });

      it('never applies the quiet check to a non-followup question', async () => {
        mockQuestionRepo.findPending.mockResolvedValue([baseQuestion]);
        mockConversationEventRepo.findMostRecentOccurredAt.mockResolvedValue(
          new Date(), // chat is active right now
        );

        const result = await facilitator.askNextQuestion(baseFamily.id);

        expect(result.success).toBe(true);
        expect(mockMessageSender.sendMessage).toHaveBeenCalled();
        expect(
          mockConversationEventRepo.findMostRecentOccurredAt,
        ).not.toHaveBeenCalled();
      });
    });

    describe('#6b — conservative cancellation on intervening activity', () => {
      it('cancels (retires) a follow-up question when the chat had activity after it was proposed', async () => {
        const proposedAnHourAgo: Question = {
          ...followupQuestion,
          createdAt: new Date(Date.now() - 60 * 60 * 1000),
        };
        mockQuestionRepo.findPending.mockResolvedValue([proposedAnHourAgo]);
        // 40 minutes ago: after the question was proposed, but still >= 30
        // minutes ago -- would pass the plain quiet check if cancellation
        // didn't take priority over it.
        mockConversationEventRepo.findMostRecentOccurredAt.mockResolvedValue(
          new Date(Date.now() - 40 * 60 * 1000),
        );

        const result = await facilitator.askNextQuestion(baseFamily.id);

        expect(result.success).toBe(true);
        expect(result.skippedReason).toBe(
          'Follow-up question superseded by chat activity',
        );
        expect(mockMessageSender.sendMessage).not.toHaveBeenCalled();
        expect(mockQuestionRepo.markAsked).not.toHaveBeenCalled();
        expect(mockQuestionRepo.retire).toHaveBeenCalledWith(
          baseFamily.id,
          proposedAnHourAgo.id,
        );
        expect(mockEventLog.log).toHaveBeenCalledWith(
          expect.objectContaining({
            familyId: baseFamily.id,
            eventType: 'question_retired',
            eventData: expect.objectContaining({
              questionId: proposedAnHourAgo.id,
              reason: 'superseded_by_activity',
            }),
          }),
        );
      });

      it('does not cancel when the most recent activity is at or before the proposal time', async () => {
        const proposedNow: Question = {
          ...followupQuestion,
          createdAt: new Date(Date.now() - 31 * 60 * 1000),
        };
        mockQuestionRepo.findPending.mockResolvedValue([proposedNow]);
        // Same moment as proposal (e.g. the triggering message itself) --
        // not activity that happened *after* it.
        mockConversationEventRepo.findMostRecentOccurredAt.mockResolvedValue(
          proposedNow.createdAt,
        );

        const result = await facilitator.askNextQuestion(baseFamily.id);

        expect(result.success).toBe(true);
        expect(mockMessageSender.sendMessage).toHaveBeenCalled();
        expect(mockQuestionRepo.retire).not.toHaveBeenCalled();
      });
    });

    describe('verbatim send', () => {
      it('sends a follow-up question verbatim, without the warmth formula', async () => {
        mockQuestionRepo.findPending.mockResolvedValue([followupQuestion]);
        mockConversationEventRepo.findMostRecentOccurredAt.mockResolvedValue(
          new Date(Date.now() - 60 * 60 * 1000),
        );

        await facilitator.askNextQuestion(baseFamily.id);

        expect(mockProvider.complete).not.toHaveBeenCalled();
        expect(mockPersonRepo.findBestMatch).not.toHaveBeenCalled();
        expect(mockMessageSender.sendMessage).toHaveBeenCalledWith(
          'facilitator',
          expect.objectContaining({
            text: followupQuestion.contentOriginal,
          }),
          expect.anything(),
        );
      });

      it('still applies the warmth formula to a non-followup question', async () => {
        mockQuestionRepo.findPending.mockResolvedValue([baseQuestion]);

        await facilitator.askNextQuestion(baseFamily.id);

        expect(mockProvider.complete).toHaveBeenCalled();
        expect(mockMessageSender.sendMessage).toHaveBeenCalledWith(
          'facilitator',
          expect.objectContaining({ text: 'Warmly formatted question!' }),
          expect.anything(),
        );
      });
    });
  });

  describe('story-followups-plan.md #6a — pause suppresses sending', () => {
    const pausedFamily: Family = {
      ...baseFamily,
      config: { ...baseFamily.config, paused: true },
    };

    it('suppresses a pending question for a paused family without sending', async () => {
      mockFamilyRepo.findById.mockResolvedValue(pausedFamily);
      mockQuestionRepo.findPending.mockResolvedValue([baseQuestion]);

      const result = await facilitator.askNextQuestion(baseFamily.id);

      expect(result.success).toBe(true);
      expect(result.skippedReason).toBe('Family is paused');
      expect(mockMessageSender.sendMessage).not.toHaveBeenCalled();
      expect(mockQuestionRepo.markAsked).not.toHaveBeenCalled();
      expect(mockEventLog.log).not.toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'question_asked' }),
      );
    });

    it('still retires expired questions for a paused family (expiry still applies)', async () => {
      mockFamilyRepo.findById.mockResolvedValue(pausedFamily);
      mockQuestionRepo.findExpiredPending.mockResolvedValue([
        { ...baseQuestion, id: 'q-expired-1' },
      ]);
      mockQuestionRepo.findPending.mockResolvedValue([]);

      await facilitator.askNextQuestion(baseFamily.id);

      expect(mockQuestionRepo.retire).toHaveBeenCalledWith(
        baseFamily.id,
        'q-expired-1',
      );
    });

    it('sends normally once a family is no longer paused', async () => {
      mockFamilyRepo.findById.mockResolvedValue({
        ...pausedFamily,
        config: { ...pausedFamily.config, paused: false },
      });
      mockQuestionRepo.findPending.mockResolvedValue([baseQuestion]);

      const result = await facilitator.askNextQuestion(baseFamily.id);

      expect(result.success).toBe(true);
      expect(mockMessageSender.sendMessage).toHaveBeenCalled();
    });

    it('suppresses every family in a batch sweep, not just the first (askQuestionsForAllFamilies)', async () => {
      const otherFamily: Family = { ...pausedFamily, id: 'family-999' };
      mockFamilyRepo.findAllActive.mockResolvedValue([
        pausedFamily,
        otherFamily,
      ]);
      mockFamilyRepo.findById.mockImplementation(async (id: string) =>
        id === pausedFamily.id ? pausedFamily : otherFamily,
      );
      mockQuestionRepo.findPending.mockResolvedValue([baseQuestion]);

      const results = await facilitator.askQuestionsForAllFamilies();

      expect(results.get(pausedFamily.id)?.skippedReason).toBe(
        'Family is paused',
      );
      expect(results.get(otherFamily.id)?.skippedReason).toBe(
        'Family is paused',
      );
      expect(mockMessageSender.sendMessage).not.toHaveBeenCalled();
    });
  });
});
