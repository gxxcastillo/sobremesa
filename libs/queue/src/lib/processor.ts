import type { ProcessingResult, ScribeDomainModel } from '@sobremesa/shared-types';
import { ConversationEventRepository, EventLogRepository } from '@sobremesa/database';
import { createLogger } from '@sobremesa/shared-utils';
import type pino from 'pino';

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
 * Message processor that orchestrates Scribe and Registrar.
 */
export class MessageProcessor {
  private eventRepo: ConversationEventRepository;
  private eventLog: EventLogRepository;
  private scribe?: ScribeProcessor;
  private registrar?: RegistrarProcessor;
  private logger: pino.Logger;

  constructor(options?: {
    eventRepo?: ConversationEventRepository;
    eventLog?: EventLogRepository;
  }) {
    this.eventRepo = options?.eventRepo || new ConversationEventRepository();
    this.eventLog = options?.eventLog || new EventLogRepository();
    this.logger = createLogger({ name: 'processor' });
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

      // Run Scribe (if configured)
      let domainModel: ScribeDomainModel | undefined;
      if (this.scribe) {
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
}
