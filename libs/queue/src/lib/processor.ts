import type { ProcessingResult, ScribeDomainModel } from '@sobremesa/shared-types';
import { ConversationEventRepository, EventLogRepository, QuestionRepository } from '@sobremesa/database';
import { createLogger } from '@sobremesa/shared-utils';
import type pino from 'pino';

/**
 * Filter result returned by the filter processor.
 */
export interface FilterProcessorResult {
  /** Whether the message should be processed by Scribe */
  relevant: boolean;
  /** Reason for the decision (for logging/debugging) */
  reason: string;
  /** Tokens used for this filter call */
  tokensUsed?: number;
}

/**
 * Filter processor function type.
 * Implementations should determine if a message is relevant for extraction.
 */
export type FilterProcessor = (
  eventId: string,
  familyId: string
) => Promise<FilterProcessorResult>;

/**
 * Scribe processor function type.
 * Implementations should extract domain model from a conversation event.
 */
export type ScribeProcessor = (
  eventId: string,
  familyId: string
) => Promise<ScribeDomainModel>;

/**
 * Registrar processor function type.
 * Implementations should persist the domain model to the database.
 */
export type RegistrarProcessor = (
  domainModel: ScribeDomainModel,
  familyId: string
) => Promise<void>;

/**
 * Message processor that orchestrates Filter, Scribe and Registrar.
 */
export class MessageProcessor {
  private eventRepo: ConversationEventRepository;
  private eventLog: EventLogRepository;
  private questionRepo: QuestionRepository;
  private filter?: FilterProcessor;
  private scribe?: ScribeProcessor;
  private registrar?: RegistrarProcessor;
  private logger: pino.Logger;

  constructor(options?: {
    eventRepo?: ConversationEventRepository;
    eventLog?: EventLogRepository;
    questionRepo?: QuestionRepository;
  }) {
    this.eventRepo = options?.eventRepo || new ConversationEventRepository();
    this.eventLog = options?.eventLog || new EventLogRepository();
    this.questionRepo = options?.questionRepo || new QuestionRepository();
    this.logger = createLogger({ name: 'processor' });
  }

  /**
   * Set the Filter processor.
   * The filter runs before Scribe to determine if a message is relevant.
   */
  setFilter(filter: FilterProcessor): void {
    this.filter = filter;
  }

  /**
   * Set the Scribe processor.
   */
  setScribe(scribe: ScribeProcessor): void {
    this.scribe = scribe;
  }

  /**
   * Set the Registrar processor.
   */
  setRegistrar(registrar: RegistrarProcessor): void {
    this.registrar = registrar;
  }

  /**
   * Process a single message through the pipeline.
   */
  async process(eventId: string, familyId: string): Promise<ProcessingResult> {
    const startTime = Date.now();

    try {
      // Load the event
      const event = await this.eventRepo.findById(familyId, eventId);
      if (!event) {
        return {
          success: false,
          error: `Event not found: ${eventId}`,
          duration: Date.now() - startTime,
        };
      }

      // Skip already processed events
      if (event.processed) {
        this.logger.debug({ eventId }, 'Event already processed, skipping');
        return {
          success: true,
          duration: Date.now() - startTime,
        };
      }

      // Skip redacted events
      if (event.redacted) {
        this.logger.debug({ eventId }, 'Event is redacted, skipping');
        await this.eventRepo.markProcessed(familyId, eventId);
        return {
          success: true,
          duration: Date.now() - startTime,
        };
      }

      // Check if this message is a reply to a question (answer detection)
      if (event.externalReplyToId) {
        await this.detectAndMarkAnswer(familyId, eventId, event.externalReplyToId);
      }

      // Log processing start
      await this.eventLog.log({
        familyId,
        eventType: 'event_processed',
        eventCategory: 'system_event',
        actor: 'processor',
        actorType: 'system',
        sourceEventId: eventId,
        eventData: { status: 'started' },
      });

      // Run Filter (if configured) to determine if message is relevant
      let shouldProcess = true;
      if (this.filter) {
        this.logger.debug({ eventId }, 'Running Filter');
        const filterResult = await this.filter(eventId, familyId);

        if (!filterResult.relevant) {
          // Message is not relevant - skip Scribe
          this.logger.info(
            { eventId, reason: filterResult.reason, tokensUsed: filterResult.tokensUsed },
            'Message filtered out as not relevant'
          );

          // Log filter skip
          await this.eventLog.log({
            familyId,
            eventType: 'event_filtered',
            eventCategory: 'system_event',
            actor: 'filter',
            actorType: 'system',
            sourceEventId: eventId,
            eventData: {
              relevant: false,
              reason: filterResult.reason,
              tokensUsed: filterResult.tokensUsed,
            },
          });

          shouldProcess = false;
        } else {
          this.logger.debug(
            { eventId, reason: filterResult.reason, tokensUsed: filterResult.tokensUsed },
            'Message passed filter'
          );
        }
      }

      // Run Scribe (if configured and filter passed)
      let domainModel: ScribeDomainModel | undefined;
      if (this.scribe && shouldProcess) {
        this.logger.debug({ eventId }, 'Running Scribe');
        domainModel = await this.scribe(eventId, familyId);
      }

      // Run Registrar (if configured and we have a domain model)
      if (this.registrar && domainModel) {
        this.logger.debug({ eventId }, 'Running Registrar');
        await this.registrar(domainModel, familyId);
      }

      // Mark event as processed
      await this.eventRepo.markProcessed(familyId, eventId);

      // Log processing complete
      await this.eventLog.log({
        familyId,
        eventType: 'event_processed',
        eventCategory: 'system_event',
        actor: 'processor',
        actorType: 'system',
        sourceEventId: eventId,
        eventData: {
          status: 'completed',
          duration: Date.now() - startTime,
          entitiesExtracted: domainModel
            ? {
                people: domainModel.people.length,
                places: domainModel.places.length,
                events: domainModel.events.length,
                claims: domainModel.claims.length,
                questions: domainModel.questions.length,
              }
            : undefined,
        },
      });

      return {
        success: true,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Log processing error
      await this.eventLog.log({
        familyId,
        eventType: 'error',
        eventCategory: 'system_event',
        actor: 'processor',
        actorType: 'system',
        sourceEventId: eventId,
        eventData: { error: errorMessage },
        severity: 'error',
      });

      this.logger.error({ eventId, error: errorMessage }, 'Processing failed');

      return {
        success: false,
        error: errorMessage,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Create a handler function for the MessageQueue.
   */
  createHandler(): (eventId: string, familyId: string) => Promise<ProcessingResult> {
    return (eventId, familyId) => this.process(eventId, familyId);
  }

  /**
   * Detect if a message is a reply to a question and mark it as answered.
   */
  private async detectAndMarkAnswer(
    familyId: string,
    answerEventId: string,
    replyToExternalId: string
  ): Promise<void> {
    try {
      // Look up if there's a question that was sent with this external message ID
      const question = await this.questionRepo.findByExternalMessageId(
        familyId,
        replyToExternalId
      );

      if (!question) {
        // Not a reply to a question we asked
        return;
      }

      // Already answered? Skip
      if (question.status === 'answered') {
        this.logger.debug(
          { questionId: question.id, replyToExternalId },
          'Question already marked as answered'
        );
        return;
      }

      // Mark the question as answered
      await this.questionRepo.markAnswered(familyId, question.id, answerEventId);

      // Log the answer detection
      await this.eventLog.log({
        familyId,
        eventType: 'question_answered',
        eventCategory: 'bot_action',
        actor: 'processor',
        actorType: 'system',
        sourceEventId: answerEventId,
        eventData: {
          questionId: question.id,
          questionContent: question.contentOriginal.slice(0, 100),
          replyToExternalId,
        },
      });

      this.logger.info(
        { familyId, questionId: question.id, answerEventId },
        'Question marked as answered via reply detection'
      );
    } catch (error) {
      // Don't fail processing if answer detection fails
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        { familyId, replyToExternalId, error: errorMessage },
        'Answer detection failed (non-fatal)'
      );
    }
  }
}
