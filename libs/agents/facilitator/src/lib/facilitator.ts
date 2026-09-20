import {
  QuestionRepository,
  FamilyRepository,
  EventLogRepository,
  FamilyAccessRepository,
  PersonRepository,
  ConversationEventRepository,
  type DatabaseClient,
} from '@sobremesa/database';
import { createLogger, logBestEffort } from '@sobremesa/shared-utils';
import type { AIProvider } from '@sobremesa/ai-provider';
import type pino from 'pino';
import {
  type Question,
  type Family,
  type MessageSender,
  detectLanguage,
  Priorities,
  DEFAULT_FACILITATOR_NAME,
  isFamilyPaused,
} from '@sobremesa/shared-types';
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildResponseSystemPrompt,
  buildResponseUserPrompt,
} from './prompt-builder';

export type { MessageSender };

/**
 * A follow-up question (`origin: 'followup'`) only gets asked once the
 * family's chat has been quiet this long (story-followups-plan.md D2). The
 * model doesn't choose timing -- this is deterministic, activity-only
 * (ADR-007), and unrelated to `minMinutesBetweenQuestions`, which throttles
 * how often *any* question gets asked regardless of origin.
 */
const FOLLOWUP_QUIET_MINUTES = 30;

/**
 * Options for FacilitatorAgent.
 */
export interface FacilitatorAgentOptions {
  /** Database client (required if repositories not provided) */
  dbClient?: DatabaseClient;
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
  /** Conversation event repository (for the follow-up quiet check) */
  conversationEventRepo?: ConversationEventRepository;
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
  /**
   * The conversation event carrying the user's question. Used as the
   * outbound-ledger dedup key (`historian-answer:<conversationEventId>`) so
   * a retried historian pass (fresh answer, different wording) never
   * resends a reply that already went out -- outbound-send-reliability-plan.md #3.
   */
  conversationEventId: string;
}

/**
 * The Facilitator agent asks warm follow-up questions to families.
 * It picks the highest priority pending question and sends it via the Facilitator bot.
 * When an AI provider is available, it applies the warmth formula to questions.
 */
export class FacilitatorAgent {
  private messageSender: MessageSender;
  private provider?: AIProvider;
  private model?: string;
  private questionRepo!: QuestionRepository;
  private familyRepo!: FamilyRepository;
  private eventLog!: EventLogRepository;
  private familyAccessRepo!: FamilyAccessRepository;
  private personRepo!: PersonRepository;
  private conversationEventRepo!: ConversationEventRepository;
  private logger: pino.Logger;
  private minMinutesBetweenQuestions: number;

  constructor(options: FacilitatorAgentOptions) {
    const { dbClient } = options;

    if (options.questionRepo) {
      this.questionRepo = options.questionRepo;
    } else if (dbClient) {
      this.questionRepo = new QuestionRepository(dbClient);
    }

    if (options.familyRepo) {
      this.familyRepo = options.familyRepo;
    } else if (dbClient) {
      this.familyRepo = new FamilyRepository(dbClient);
    }

    if (options.eventLog) {
      this.eventLog = options.eventLog;
    } else if (dbClient) {
      this.eventLog = new EventLogRepository(dbClient);
    }

    if (options.familyAccessRepo) {
      this.familyAccessRepo = options.familyAccessRepo;
    } else if (dbClient) {
      this.familyAccessRepo = new FamilyAccessRepository(dbClient);
    }

    if (options.personRepo) {
      this.personRepo = options.personRepo;
    } else if (dbClient) {
      this.personRepo = new PersonRepository(dbClient);
    }

    if (options.conversationEventRepo) {
      this.conversationEventRepo = options.conversationEventRepo;
    } else if (dbClient) {
      this.conversationEventRepo = new ConversationEventRepository(dbClient);
    }

    if (
      !this.questionRepo ||
      !this.familyRepo ||
      !this.eventLog ||
      !this.familyAccessRepo ||
      !this.personRepo ||
      !this.conversationEventRepo
    ) {
      throw new Error(
        'FacilitatorAgent requires either dbClient or all repository instances',
      );
    }

    this.messageSender = options.messageSender;
    this.provider = options.provider;
    this.model = options.model;
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
      // 1. Retire any follow-up questions that expired unasked, before
      // considering what to ask. `findPending` already excludes expired
      // rows on its own, so this doesn't change what gets asked below --
      // it's cleanup, keeping `status` accurate for Studio/audit review.
      await this.retireExpiredQuestions(familyId);

      // 2. Get the family to find the chat ID
      const family = await this.familyRepo.findById(familyId);
      if (!family) {
        return { success: false, error: 'Family not found' };
      }

      // A paused family gets no unprompted sends -- ingestion already checks
      // this (chatbot.ts's getActiveFamilyForChat); a pending question must
      // not bypass it just because it was proposed before the pause (#6a).
      // After expiry retirement (step 1) so a paused family's stale
      // questions still retire; before anything below marks a send attempt.
      if (isFamilyPaused(family.config)) {
        return { success: true, skippedReason: 'Family is paused' };
      }

      const chatId = family.chatId;
      if (!chatId) {
        return {
          success: false,
          skippedReason: 'Family has no chat ID configured',
        };
      }

      // 3. Check if we asked a question recently
      const recentlyAsked = await this.wasQuestionAskedRecently(familyId);
      if (recentlyAsked) {
        return {
          success: true,
          skippedReason: `Question asked within last ${this.minMinutesBetweenQuestions} minutes`,
        };
      }

      // 4. Get pending questions ordered by priority
      const pending = await this.questionRepo.findPending(familyId, 1);
      if (pending.length === 0) {
        return { success: true, skippedReason: 'No pending questions' };
      }

      const question = pending[0];

      // 5. A follow-up question waits for the chat to go quiet (D2), and is
      // cancelled outright if anything happened since it was proposed
      // (#6b, conservative policy) -- every other origin has no such gate.
      if (question.origin === 'followup') {
        const timingResult = await this.evaluateFollowupTiming(
          familyId,
          question,
        );
        if (timingResult) {
          return timingResult;
        }
      }

      // 6. Send the question via Facilitator bot
      const externalMessageId = await this.sendQuestion(
        family,
        question,
        chatId,
      );

      // 7. Mark as asked with the external message ID for answer detection,
      // and stamp the persona name so a later reply's answeredQuestion
      // context can read it back instead of hardcoding a role name.
      const askedByName =
        family.config.bots?.facilitator?.displayName ??
        DEFAULT_FACILITATOR_NAME;
      await this.questionRepo.markAsked(
        familyId,
        question.id,
        undefined,
        externalMessageId,
        askedByName,
      );

      // 8. Log the event
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
   * Returns the Telegram message_id of the sent message, or `undefined` if
   * the outcome was a duplicate with no recorded id or was unconfirmed
   * (ambiguous outcome -- never resent; see `outbound-send-reliability-plan.md`).
   * Caller (`askNextQuestion`) already verified `family.chatId` is present
   * and passes it as `chatId`.
   */
  private async sendQuestion(
    family: Family,
    question: Question,
    chatId: string,
  ): Promise<number | undefined> {
    // Apply warmth formula via AI if available. A story follow-up is sent
    // verbatim -- provisional exception to the warmth formula, see
    // spec/product/warmth.md and ADR-033.
    let message: string;
    if (question.origin === 'followup') {
      message = question.contentOriginal;
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

    // Bot-initiated question, low priority (shouldn't interrupt user
    // interactions). Dedup-keyed on the question id: a re-ask nudge that
    // arrives after a successful send but a failed `markAsked` (FM6) claims
    // the same key, gets `duplicate` back with the already-recorded message
    // id, and skips the resend -- `askNextQuestion` below then retries
    // `markAsked` with that id, self-healing instead of double-asking. Two
    // concurrent triggers (sweep + nudge) racing the same question resolve
    // the same way: only one claims and sends.
    const outcome = await this.messageSender.sendMessage(
      'facilitator',
      {
        chatId,
        text: message,
      },
      {
        priority: Priorities.BOT_QUESTION,
        dedup: {
          familyId: family.id,
          key: `facilitator:question:${question.id}`,
          questionId: question.id,
        },
      },
    );
    return outcome.status === 'sent' || outcome.status === 'duplicate'
      ? outcome.messageId
      : undefined;
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
    if (!this.provider || !this.model) {
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
   * Keyed on the most recent `asked_at` regardless of the question's current
   * status: an answered question was still asked, so it must still throttle.
   */
  private async wasQuestionAskedRecently(familyId: string): Promise<boolean> {
    const askedAt = await this.questionRepo.findMostRecentAskedAt(familyId);
    if (!askedAt) {
      return false;
    }

    const minutesSinceAsked = (Date.now() - askedAt.getTime()) / (1000 * 60);

    return minutesSinceAsked < this.minMinutesBetweenQuestions;
  }

  /**
   * True once the family's chat has been quiet for `FOLLOWUP_QUIET_MINUTES`
   * (story-followups-plan.md D2). Reads only the timestamp of the last
   * conversation event -- never its content, so ADR-007 holds. No activity
   * ever recorded means nothing to wait on.
   */
  /**
   * A follow-up question's timing gate. Returns a result to return early
   * with (cancelled or still waiting), or `null` when it's eligible to send
   * now.
   *
   * #6b, decided 2026-09-18 (conservative policy, not the bounded
   * content-aware recheck): any chat activity recorded after the question
   * was proposed cancels it outright, with no re-check of whether it would
   * still fit -- a happy question proposed just before sad news arrives
   * must not go out unchanged once the chat finally quiets down again.
   * Facilitator stays activity-only (ADR-007); this reads only a timestamp,
   * never content. Logged with the proposal-to-cancellation gap so a future
   * session can measure how often this fires before building the smarter
   * recheck the review also raised.
   */
  private async evaluateFollowupTiming(
    familyId: string,
    question: Question,
  ): Promise<AskQuestionResult | null> {
    const lastEventAt =
      await this.conversationEventRepo.findMostRecentOccurredAt(familyId);

    if (lastEventAt && lastEventAt > question.createdAt) {
      await this.questionRepo.retire(familyId, question.id);
      await this.eventLog.log({
        familyId,
        eventType: 'question_retired',
        eventCategory: 'system_event',
        actor: 'facilitator',
        actorType: 'system',
        conversationEventId: question.sourceMessageId,
        eventData: {
          questionId: question.id,
          reason: 'superseded_by_activity',
          proposedAt: question.createdAt.toISOString(),
          lastActivityAt: lastEventAt.toISOString(),
        },
      });
      this.logger.info(
        { familyId, questionId: question.id },
        'Follow-up question superseded by chat activity during the wait',
      );
      return {
        success: true,
        skippedReason: 'Follow-up question superseded by chat activity',
      };
    }

    const minutesSinceLastEvent = lastEventAt
      ? (Date.now() - lastEventAt.getTime()) / (1000 * 60)
      : Infinity;
    if (minutesSinceLastEvent < FOLLOWUP_QUIET_MINUTES) {
      return {
        success: true,
        skippedReason: `Follow-up question waiting for ${FOLLOWUP_QUIET_MINUTES} minutes of quiet`,
      };
    }

    return null;
  }

  /**
   * Retire every proposed question past its `expires_at` (D3) before this
   * family's next question is chosen. `findPending` already excludes
   * expired rows on its own -- this only keeps `status` accurate and logs
   * `question_retired` for audit/Studio review.
   */
  private async retireExpiredQuestions(familyId: string): Promise<void> {
    const expired = await this.questionRepo.findExpiredPending(familyId);

    for (const question of expired) {
      await this.questionRepo.retire(familyId, question.id);
      await this.eventLog.log({
        familyId,
        eventType: 'question_retired',
        eventCategory: 'system_event',
        actor: 'facilitator',
        actorType: 'system',
        conversationEventId: question.sourceMessageId,
        eventData: { questionId: question.id, reason: 'expired' },
      });
      this.logger.info(
        { familyId, questionId: question.id },
        'Retired expired question',
      );
    }
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
      conversationEventId,
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

      // 3. Send the response via Facilitator bot (bot-initiated, low priority).
      // Dedup-keyed on the question's conversation event: a retry that
      // re-runs historian.answer() and calls sendResponse again reuses the
      // same key, so a prior successful send is never repeated.
      await this.messageSender.sendMessage(
        'facilitator',
        {
          chatId,
          text: formattedResponse,
          replyToMessageId,
        },
        {
          priority: Priorities.BOT_QUESTION,
          dedup: {
            familyId,
            key: `historian-answer:${conversationEventId}`,
            conversationEventId,
          },
        },
      );

      // 4. Log the event. Best-effort: the response above already reached
      // the family, so a logging failure here must not turn into a reported
      // failure — the processor retries a failed historian result, which
      // would resend the (already-delivered) answer.
      await logBestEffort(
        this.logger,
        () =>
          this.eventLog.log({
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
          }),
        { familyId },
        'Failed to log question-responded event (response already sent)',
      );

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
    if (!this.provider || !this.model) {
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
