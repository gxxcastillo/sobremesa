import {
  QuestionRepository,
  FamilyRepository,
  EventLogRepository,
  FamilyAccessRepository,
  PersonRepository,
} from '@sobremesa/database';
import { createLogger } from '@sobremesa/shared-utils';
import type { AIProvider } from '@sobremesa/ai-provider';
import type pino from 'pino';
import {
  BotRole,
  type Question,
  type Family,
  type MessageSender,
  detectLanguage,
  Priorities,
} from '@sobremesa/shared-types';
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildResponseSystemPrompt,
  buildResponseUserPrompt,
} from './prompt-builder';

export type { MessageSender };

/**
 * Options for FacilitatorAgent.
 */
export interface FacilitatorAgentOptions {
  /** Message sender (typically BotManager) */
  messageSender: MessageSender;
  /** AI provider for warmth transformation (optional - falls back to verbatim if not provided) */
  provider?: AIProvider;
  /** Model to use for warmth transformation */
  model?: string;
  /** Question repository */
  questionRepo?: QuestionRepository;
  /** Family repository */
  familyRepo?: FamilyRepository;
  /** Event log repository */
  eventLog?: EventLogRepository;
  /** Family access repository (for participant checks) */
  familyAccessRepo?: FamilyAccessRepository;
  /** Person repository (for name lookups) */
  personRepo?: PersonRepository;
  /** Logger instance */
  logger?: pino.Logger;
  /** Minimum minutes between questions to same family */
  minMinutesBetweenQuestions?: number;
}

/**
 * Result of asking a question.
 */
export interface AskQuestionResult {
  success: boolean;
  questionId?: string;
  questionContent?: string;
  error?: string;
  skippedReason?: string;
}

/**
 * Result of sending a response (formatted historian answer).
 */
export interface SendResponseResult {
  success: boolean;
  formattedResponse?: string;
  error?: string;
}

/**
 * Options for sending a historian response through the Facilitator.
 */
export interface SendResponseOptions {
  /** Family ID */
  familyId: string;
  /** The original question that was asked */
  originalQuestion: string;
  /** The raw answer from the historian */
  historianAnswer: string;
  /** Chat ID to send to */
  chatId: string;
  /** Message ID to reply to (optional) */
  replyToMessageId?: number;
}

/** Default model to use for warmth transformation (fast and cheap) */
const DEFAULT_WARMTH_MODEL = 'claude-3-5-haiku-latest';

/**
 * The Facilitator agent asks warm follow-up questions to families.
 * It picks the highest priority pending question and sends it via the Facilitator bot.
 * When an AI provider is available, it applies the warmth formula to questions.
 */
export class FacilitatorAgent {
  private messageSender: MessageSender;
  private provider?: AIProvider;
  private model: string;
  private questionRepo: QuestionRepository;
  private familyRepo: FamilyRepository;
  private eventLog: EventLogRepository;
  private familyAccessRepo: FamilyAccessRepository;
  private personRepo: PersonRepository;
  private logger: pino.Logger;
  private minMinutesBetweenQuestions: number;

  constructor(options: FacilitatorAgentOptions) {
    this.messageSender = options.messageSender;
    this.provider = options.provider;
    this.model = options.model || DEFAULT_WARMTH_MODEL;
    this.questionRepo = options.questionRepo || new QuestionRepository();
    this.familyRepo = options.familyRepo || new FamilyRepository();
    this.eventLog = options.eventLog || new EventLogRepository();
    this.familyAccessRepo =
      options.familyAccessRepo || new FamilyAccessRepository();
    this.personRepo = options.personRepo || new PersonRepository();
    this.logger = options.logger || createLogger({ name: 'facilitator' });
    this.minMinutesBetweenQuestions = options.minMinutesBetweenQuestions ?? 60; // Default 1 hour
  }

  /**
   * Ask the next pending question for a family.
   * Returns the result including whether a question was asked or skipped.
   */
  async askNextQuestion(familyId: string): Promise<AskQuestionResult> {
    this.logger.info({ familyId }, 'Checking for questions to ask');

    try {
      // 1. Get the family to find the chat ID
      const family = await this.familyRepo.findById(familyId);
      if (!family) {
        return { success: false, error: 'Family not found' };
      }

      if (!family.chatId) {
        return {
          success: false,
          skippedReason: 'Family has no chat ID configured',
        };
      }

      // 2. Check if we asked a question recently
      const recentlyAsked = await this.wasQuestionAskedRecently(familyId);
      if (recentlyAsked) {
        return {
          success: true,
          skippedReason: `Question asked within last ${this.minMinutesBetweenQuestions} minutes`,
        };
      }

      // 3. Get pending questions ordered by priority
      const pending = await this.questionRepo.findPending(familyId, 1);
      if (pending.length === 0) {
        return { success: true, skippedReason: 'No pending questions' };
      }

      const question = pending[0];

      // 4. Send the question via Facilitator bot
      const externalMessageId = await this.sendQuestion(family, question);

      // 5. Mark as asked with the external message ID for answer detection
      await this.questionRepo.markAsked(
        familyId,
        question.id,
        undefined,
        externalMessageId,
      );

      // 6. Log the event
      await this.eventLog.log({
        familyId,
        eventType: 'question_asked',
        eventCategory: 'bot_action',
        actor: 'facilitator',
        actorType: 'system',
        eventData: {
          questionId: question.id,
          priority: question.priority,
          content: question.contentOriginal.slice(0, 100),
        },
      });

      this.logger.info(
        { familyId, questionId: question.id, priority: question.priority },
        'Question asked successfully',
      );

      return {
        success: true,
        questionId: question.id,
        questionContent: question.contentOriginal,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        { familyId, error: errorMessage },
        'Failed to ask question',
      );
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Send a question to the family chat.
   * Applies warmth formula via AI if Anthropic client is available.
   * Returns the Telegram message_id of the sent message.
   */
  private async sendQuestion(
    family: Family,
    question: Question,
  ): Promise<number> {
    // Apply warmth formula via AI if available
    let message: string;
    if (!family.chatId) {
      const error = new Error('Failed to send message, missing clientId');
      this.logger.warn(
        { questionId: question.id, error },
        'Failed to apply warmth, falling back to verbatim',
      );

      return NaN;
    } else if (this.provider) {
      try {
        // Check if target person is a verified participant
        const isTargetParticipant = await this.checkTargetParticipant(
          family,
          question,
        );

        message = await this.formatWithWarmth(
          family,
          question,
          isTargetParticipant,
        );
        this.logger.debug(
          { questionId: question.id, isTargetParticipant },
          'Applied warmth formula via AI',
        );
      } catch (error) {
        this.logger.warn(
          { questionId: question.id, error },
          'Failed to apply warmth, falling back to verbatim',
        );
        message = question.contentOriginal;
      }
    } else {
      // No AI provider - send verbatim
      message = question.contentOriginal;
    }

    // Bot-initiated question, low priority (shouldn't interrupt user interactions)
    return await this.messageSender.sendMessage(
      BotRole.FACILITATOR,
      {
        chatId: family.chatId,
        text: message,
      },
      { priority: Priorities.BOT_QUESTION },
    );
  }

  /**
   * Check if the question's target person is a verified participant in the chat.
   * Returns:
   *   - true: Person is verified to be in the chat (address them directly)
   *   - false: Person is NOT in the chat (mentioned in story only)
   *   - undefined: No target person, or lookup failed
   */
  private async checkTargetParticipant(
    family: Family,
    question: Question,
  ): Promise<boolean | undefined> {
    if (!question.targetPerson || !family.chatId) {
      return undefined;
    }

    try {
      // Look up person by name
      const matchResult = await this.personRepo.findBestMatch(
        family.id,
        question.targetPerson,
        [],
      );

      if (!matchResult?.person) {
        this.logger.debug(
          { familyId: family.id, targetPerson: question.targetPerson },
          'Target person not found in family',
        );
        return false;
      }

      // Check if person is a participant in the conversation
      const isParticipant = await this.familyAccessRepo.isPersonParticipant(
        family.id,
        family.chatId,
        matchResult.person.id,
      );

      this.logger.debug(
        {
          familyId: family.id,
          targetPerson: question.targetPerson,
          personId: matchResult.person.id,
          isParticipant,
        },
        'Checked target person participation',
      );

      return isParticipant;
    } catch (error) {
      this.logger.warn(
        { familyId: family.id, targetPerson: question.targetPerson, error },
        'Failed to check target participant, defaulting to group addressing',
      );
      return undefined;
    }
  }

  /**
   * Apply the warmth formula to a question using AI.
   * Uses a fast model for cheap transformation.
   *
   * @param family - The family configuration
   * @param question - The question to transform
   * @param isTargetParticipant - Whether target person is verified participant
   */
  private async formatWithWarmth(
    family: Family,
    question: Question,
    isTargetParticipant?: boolean,
  ): Promise<string> {
    if (!this.provider) {
      throw new Error('No AI provider available for warmth formatting');
    }

    const systemPrompt = buildSystemPrompt(family.config);
    const userPrompt = buildUserPrompt(question, isTargetParticipant);

    const response = await this.provider.complete({
      model: this.model,
      maxTokens: 512,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    return response.content.trim();
  }

  /**
   * Check if a question was asked recently (within minMinutesBetweenQuestions).
   */
  private async wasQuestionAskedRecently(familyId: string): Promise<boolean> {
    const questions = await this.questionRepo.findByStatus(familyId, 'asked');

    if (questions.length === 0) {
      return false;
    }

    // Find the most recently asked question
    const mostRecent = questions.reduce((latest: Question, q: Question) => {
      if (!q.askedAt) return latest;
      if (!latest.askedAt) return q;
      return new Date(q.askedAt) > new Date(latest.askedAt) ? q : latest;
    }, questions[0]);

    if (!mostRecent.askedAt) {
      return false;
    }

    const askedAt = new Date(mostRecent.askedAt);
    const minutesSinceAsked = (Date.now() - askedAt.getTime()) / (1000 * 60);

    return minutesSinceAsked < this.minMinutesBetweenQuestions;
  }

  /**
   * Ask questions for all active families that have pending questions.
   * Useful for batch processing or scheduled jobs.
   */
  async askQuestionsForAllFamilies(): Promise<Map<string, AskQuestionResult>> {
    const results = new Map<string, AskQuestionResult>();

    // Get all active families with chat IDs
    const families = await this.familyRepo.findAllActive();
    const activeFamilies = families.filter((f: Family) => f.chatId);

    this.logger.info(
      { familyCount: activeFamilies.length },
      'Checking questions for all families',
    );

    for (const family of activeFamilies) {
      const result = await this.askNextQuestion(family.id);
      results.set(family.id, result);
    }

    return results;
  }

  /**
   * Format and send a historian's answer with appropriate warmth and language.
   * Detects the language of the original question and responds in that language.
   */
  async sendResponse(
    options: SendResponseOptions,
  ): Promise<SendResponseResult> {
    const {
      familyId,
      originalQuestion,
      historianAnswer,
      chatId,
      replyToMessageId,
    } = options;

    this.logger.info({ familyId }, 'Formatting historian response');

    try {
      // 1. Get the family for config
      const family = await this.familyRepo.findById(familyId);
      if (!family) {
        return { success: false, error: 'Family not found' };
      }

      // 2. Format the response with warmth and appropriate language
      let formattedResponse: string;
      if (this.provider) {
        try {
          formattedResponse = await this.formatResponseWithWarmth(
            family,
            originalQuestion,
            historianAnswer,
          );
          this.logger.debug({ familyId }, 'Applied warmth formula to response');
        } catch (error) {
          this.logger.warn(
            { familyId, error },
            'Failed to apply warmth to response, falling back to raw answer',
          );
          formattedResponse = historianAnswer;
        }
      } else {
        // No AI provider - send raw historian answer
        formattedResponse = historianAnswer;
      }

      // 3. Send the response via Facilitator bot (bot-initiated, low priority)
      await this.messageSender.sendMessage(
        BotRole.FACILITATOR,
        {
          chatId,
          text: formattedResponse,
          replyToMessageId,
        },
        { priority: Priorities.BOT_QUESTION },
      );

      // 4. Log the event
      await this.eventLog.log({
        familyId,
        eventType: 'question_responded',
        eventCategory: 'bot_action',
        actor: 'facilitator',
        actorType: 'system',
        eventData: {
          questionLength: originalQuestion.length,
          responseLength: formattedResponse.length,
          hasReplyTo: !!replyToMessageId,
        },
      });

      this.logger.info({ familyId }, 'Response sent successfully');

      return {
        success: true,
        formattedResponse,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        { familyId, error: errorMessage },
        'Failed to send response',
      );
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Apply warmth formula and language detection to a historian response.
   */
  private async formatResponseWithWarmth(
    family: Family,
    originalQuestion: string,
    historianAnswer: string,
  ): Promise<string> {
    if (!this.provider) {
      throw new Error('No AI provider available for warmth formatting');
    }

    // Detect the language of the original question
    const questionLanguage = detectLanguage(originalQuestion);
    this.logger.debug({ questionLanguage }, 'Detected question language');

    const systemPrompt = buildResponseSystemPrompt(
      family.config,
      questionLanguage,
    );
    const userPrompt = buildResponseUserPrompt(
      originalQuestion,
      historianAnswer,
    );

    const response = await this.provider.complete({
      model: this.model,
      maxTokens: 1024, // Responses can be longer than questions
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    return response.content.trim();
  }
}
