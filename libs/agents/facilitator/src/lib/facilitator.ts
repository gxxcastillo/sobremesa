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
} from '@sobremesa/shared-types';

export type { MessageSender };

/**
 * Options for FacilitatorAgent.
 */
export interface FacilitatorAgentOptions {
  /** Message sender (typically BotManager) */
  messageSender: MessageSender;
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
 * The Facilitator agent asks warm follow-up questions to families.
 * It picks the highest priority pending question and sends it via the Facilitator bot.
 */
export class FacilitatorAgent {
  private messageSender: MessageSender;
  private questionRepo: QuestionRepository;
  private familyRepo: FamilyRepository;
  private eventLog: EventLogRepository;
  private logger: pino.Logger;
  private minMinutesBetweenQuestions: number;

  constructor(options: FacilitatorAgentOptions) {
    this.messageSender = options.messageSender;
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
        externalMessageId
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
        'Question asked successfully'
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
        'Failed to ask question'
      );
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Send a question to the family chat.
   * Returns the Telegram message_id of the sent message.
   */
  private async sendQuestion(
    family: Family,
    question: Question
  ): Promise<number> {
    // Format the question with warmth
    // The question should already be warm from Scribe, but we can add context
    const message = question.contentOriginal;

    return await this.messageSender.sendMessage(BotRole.FACILITATOR, {
      chatId: family.chatId!,
      text: message,
    });
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
      'Checking questions for all families'
    );

    for (const family of activeFamilies) {
      const result = await this.askNextQuestion(family.id);
      results.set(family.id, result);
    }

    return results;
  }
}
