import {
  QuestionRepository,
  FamilyRepository,
  EventLogRepository,
} from '@sobremesa/database';
import { createLogger } from '@sobremesa/shared-utils';
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
 * Anthropic client interface.
 * Using unknown to avoid TypeScript version mismatches across workspace packages.
 * The actual Anthropic client from @anthropic-ai/sdk should be passed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnthropicClient = any;

/**
 * Options for FacilitatorAgent.
 */
export interface FacilitatorAgentOptions {
  /** Message sender (typically BotManager) */
  messageSender: MessageSender;
  /** Anthropic client for warmth transformation (optional - falls back to verbatim if not provided) */
  anthropic?: AnthropicClient;
  /** Question repository */
  questionRepo?: QuestionRepository;
  /** Family repository */
  familyRepo?: FamilyRepository;
  /** Event log repository */
  eventLog?: EventLogRepository;
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

/** Model to use for warmth transformation (fast and cheap) */
const WARMTH_MODEL = 'claude-3-5-haiku-latest';

/**
 * The Facilitator agent asks warm follow-up questions to families.
 * It picks the highest priority pending question and sends it via the Facilitator bot.
 * When an Anthropic client is provided, it applies the warmth formula to questions.
 */
export class FacilitatorAgent {
  private messageSender: MessageSender;
  private anthropic?: AnthropicClient;
  private questionRepo: QuestionRepository;
  private familyRepo: FamilyRepository;
  private eventLog: EventLogRepository;
  private logger: pino.Logger;
  private minMinutesBetweenQuestions: number;

  constructor(options: FacilitatorAgentOptions) {
    this.messageSender = options.messageSender;
    this.anthropic = options.anthropic;
    this.questionRepo = options.questionRepo || new QuestionRepository();
    this.familyRepo = options.familyRepo || new FamilyRepository();
    this.eventLog = options.eventLog || new EventLogRepository();
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
    } else if (this.anthropic) {
      try {
        message = await this.formatWithWarmth(family, question);
        this.logger.debug(
          { questionId: question.id },
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
      // No AI client - send verbatim
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
   * Apply the warmth formula to a question using AI.
   * Uses Haiku for fast, cheap transformation.
   */
  private async formatWithWarmth(
    family: Family,
    question: Question,
  ): Promise<string> {
    const systemPrompt = buildSystemPrompt(family.config);
    const userPrompt = buildUserPrompt(question);

    const response = await this.anthropic.messages.create({
      model: WARMTH_MODEL,
      max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    // Extract the text from the response
    const content = response.content[0];
    if (content.type !== 'text') {
      throw new Error('Unexpected response type from AI');
    }

    return content.text.trim();
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
      if (this.anthropic) {
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
        // No AI client - send raw historian answer
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

    const response = await this.anthropic.messages.create({
      model: WARMTH_MODEL,
      max_tokens: 1024, // Responses can be longer than questions
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    // Extract the text from the response
    const content = response.content[0];
    if (content.type !== 'text') {
      throw new Error('Unexpected response type from AI');
    }

    return content.text.trim();
  }
}
