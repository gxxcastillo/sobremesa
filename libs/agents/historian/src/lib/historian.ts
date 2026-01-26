import {
  ConversationEventRepository,
  EventLogRepository,
  FamilyRepository,
} from '@sobremesa/database';
import { createLogger } from '@sobremesa/shared-utils';
import type { AIProvider } from '@sobremesa/ai-provider';
import type pino from 'pino';
import { parseQuestion, isQuestion } from './question-parser';
import { DataRetriever } from './retriever';
import { buildSystemPrompt, buildUserPrompt } from './prompt-builder';
import {
  type HistorianConfig,
  type HistorianReply,
  DEFAULT_HISTORIAN_CONFIG,
} from './types';

/**
 * Options for HistorianAgent.
 */
export interface HistorianAgentOptions {
  /** AI provider for completions */
  provider: AIProvider;
  /** Model to use */
  model: string;
  /** Conversation event repository */
  eventRepo?: ConversationEventRepository;
  /** Family repository */
  familyRepo?: FamilyRepository;
  /** Event log repository */
  eventLog?: EventLogRepository;
  /** Data retriever */
  retriever?: DataRetriever;
  /** Logger instance */
  logger?: pino.Logger;
  /** Configuration overrides */
  config?: Partial<HistorianConfig>;
}

/**
 * The Historian agent answers questions about collected family history.
 * It queries the database, retrieves relevant information, and synthesizes
 * accurate responses with source attribution. The response is returned
 * for the Facilitator to format and send with appropriate warmth/language.
 */
export class HistorianAgent {
  private provider: AIProvider;
  private model: string;
  private eventRepo: ConversationEventRepository;
  // @ts-expect-error FamilyRepo is available for future use (e.g., getting family name for responses)
  private _familyRepo: FamilyRepository;
  private eventLog: EventLogRepository;
  private retriever: DataRetriever;
  private logger: pino.Logger;
  private config: HistorianConfig;

  constructor(options: HistorianAgentOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.eventRepo = options.eventRepo || new ConversationEventRepository();
    this._familyRepo = options.familyRepo || new FamilyRepository();
    this.eventLog = options.eventLog || new EventLogRepository();
    this.retriever = options.retriever || new DataRetriever();
    this.logger = options.logger || createLogger({ name: 'historian' });
    this.config = { ...DEFAULT_HISTORIAN_CONFIG, ...options.config };
  }

  /**
   * Check if a message text contains a question.
   */
  isQuestion(text: string): boolean {
    return isQuestion(text);
  }

  /**
   * Answer a question from a conversation event.
   *
   * @param eventId - The conversation event ID containing the question
   * @param familyId - The family ID
   */
  async answer(eventId: string, familyId: string): Promise<HistorianReply> {
    this.logger.info({ eventId, familyId }, 'Processing question');

    try {
      // Load the event
      const event = await this.eventRepo.findById(familyId, eventId);
      if (!event) {
        return { success: false, error: 'Event not found' };
      }

      const questionText = event.contentOriginal?.trim();
      if (!questionText) {
        return { success: false, error: 'Empty message' };
      }

      // Parse the question
      const parsedQuestion = parseQuestion(questionText);
      this.logger.debug(
        {
          eventId,
          questionType: parsedQuestion.type,
          entities: parsedQuestion.entities,
          keywords: parsedQuestion.keywords,
        },
        'Question parsed',
      );

      // Retrieve relevant context
      const context = await this.retriever.retrieve(
        familyId,
        parsedQuestion,
        this.config,
      );
      this.logger.debug(
        {
          eventId,
          peopleCount: context.people.length,
          eventsCount: context.events.length,
          storiesCount: context.stories.length,
          claimsCount: context.claims.length,
          hasConflicts: context.hasConflicts,
        },
        'Context retrieved',
      );

      // Build prompts
      const systemPrompt = buildSystemPrompt(this.config);
      const userPrompt = buildUserPrompt(parsedQuestion, context);

      // Call AI provider to synthesize answer
      const response = await this.provider.complete({
        model: this.model,
        maxTokens: this.config.maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const answerText = response.content;
      if (!answerText) {
        return { success: false, error: 'Unexpected or empty response' };
      }

      // Calculate data points used
      const dataPointsUsed =
        context.people.length +
        context.events.length +
        context.stories.length +
        context.claims.length;

      // Get tokens used from response
      const tokensUsed = response.usage.totalTokens;

      // Prepare reply metadata
      const externalMessageId = event.externalEventId
        ? parseInt(event.externalEventId, 10)
        : undefined;
      const replyToMessageId =
        externalMessageId && !isNaN(externalMessageId)
          ? externalMessageId
          : NaN;

      // Log the answer generation (message will be sent by Facilitator)
      await this.eventLog.log({
        familyId,
        eventType: 'question_answered',
        eventCategory: 'bot_action',
        actor: 'historian',
        actorType: 'system',
        sourceEventId: eventId,
        eventData: {
          questionType: parsedQuestion.type,
          dataPointsUsed,
          hasConflicts: context.hasConflicts,
          tokensUsed,
          answerLength: answerText.length,
        },
      });

      this.logger.info(
        {
          eventId,
          familyId,
          questionType: parsedQuestion.type,
          dataPointsUsed,
          hasConflicts: context.hasConflicts,
          tokensUsed,
        },
        'Answer generated successfully (pending Facilitator formatting)',
      );

      // Return the answer for the Facilitator to format and send
      return {
        success: true,
        answer: answerText,
        originalQuestion: questionText,
        chatId: event.conversationId,
        replyToMessageId,
        questionType: parsedQuestion.type,
        dataPointsUsed,
        hasConflicts: context.hasConflicts,
        tokensUsed,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        { eventId, familyId, error: errorMessage },
        'Failed to answer question',
      );
      return { success: false, error: errorMessage };
    }
  }
}
