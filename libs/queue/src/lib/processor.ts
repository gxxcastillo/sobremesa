import {
  Confidence,
  type ProcessingResult,
  type ScribeDomainModel,
} from '@sobremesa/shared-types';
import {
  ConversationEventRepository,
  EventLogRepository,
  QuestionRepository,
  ImageRepository,
} from '@sobremesa/database';
import { createLogger } from '@sobremesa/shared-utils';
import type pino from 'pino';

/**
 * Media event types that should create Image records.
 */
const MEDIA_EVENT_TYPES = ['photo', 'document', 'video'] as const;
type MediaEventType = (typeof MEDIA_EVENT_TYPES)[number];

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
 * Image reference type for linking.
 */
export type ImageReferenceType =
  | 'describes'
  | 'identifies_people'
  | 'provides_context'
  | 'asks_about';

/**
 * Image link result returned by the image linker processor.
 */
export interface ImageLinkProcessorResult {
  /** Whether the message references an image */
  linked: boolean;
  /** The image ID if linked */
  imageId?: string;
  /** How the message references the image */
  referenceType?: ImageReferenceType;
  /** Brief explanation */
  reason: string;
  /** Tokens used for this call */
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
 * Image linker processor function type.
 * Implementations should determine if a message references a recent image.
 */
export type ImageLinkerProcessor = (
  eventId: string,
  familyId: string
) => Promise<ImageLinkProcessorResult>;

/**
 * Callback for when a new image is ready for async analysis.
 * The Curator should be called with this image ID to analyze it.
 */
export type OnImageCreatedCallback = (
  familyId: string,
  imageId: string,
  eventId: string
) => void;

/**
 * Message processor that orchestrates Filter, Scribe, and Registrar.
 * Media events create Image records and notify via callback for async Curator analysis.
 */
export class MessageProcessor {
  private eventRepo: ConversationEventRepository;
  private eventLog: EventLogRepository;
  private questionRepo: QuestionRepository;
  private imageRepo: ImageRepository;
  private filter?: FilterProcessor;
  private imageLinker?: ImageLinkerProcessor;
  private scribe?: ScribeProcessor;
  private registrar?: RegistrarProcessor;
  private onImageCreated?: OnImageCreatedCallback;
  private logger: pino.Logger;

  constructor(options?: {
    eventRepo?: ConversationEventRepository;
    eventLog?: EventLogRepository;
    questionRepo?: QuestionRepository;
    imageRepo?: ImageRepository;
  }) {
    this.eventRepo = options?.eventRepo || new ConversationEventRepository();
    this.eventLog = options?.eventLog || new EventLogRepository();
    this.questionRepo = options?.questionRepo || new QuestionRepository();
    this.imageRepo = options?.imageRepo || new ImageRepository();
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
   * Set the Image Linker processor.
   * The image linker runs after Scribe to detect image references that Scribe may have missed.
   */
  setImageLinker(imageLinker: ImageLinkerProcessor): void {
    this.imageLinker = imageLinker;
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
   * Set callback for when an image is created and ready for async Curator analysis.
   */
  setOnImageCreated(callback: OnImageCreatedCallback): void {
    this.onImageCreated = callback;
  }

  /**
   * Check if an event type is a media type.
   */
  private isMediaEvent(eventType: string): eventType is MediaEventType {
    return MEDIA_EVENT_TYPES.includes(eventType as MediaEventType);
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
        await this.detectAndMarkAnswer(
          familyId,
          eventId,
          event.externalReplyToId
        );
      }

      // Log processing start
      await this.eventLog.log({
        familyId,
        eventType: 'event_processed',
        eventCategory: 'system_event',
        actor: 'processor',
        actorType: 'system',
        sourceEventId: eventId,
        eventData: { status: 'started', eventType: event.eventType },
      });

      // Handle media events: create Image record for async Curator
      let imageId: string | undefined;
      if (this.isMediaEvent(event.eventType)) {
        imageId = await this.createImageRecord(eventId, familyId, event);
      }

      // Process text content through Filter/Scribe (including media captions)
      if (event.contentOriginal || event.eventType === 'message') {
        await this.processTextContent(eventId, familyId);
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
          eventType: event.eventType,
          imageId,
        },
      });

      return {
        success: true,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

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
  createHandler(): (
    eventId: string,
    familyId: string
  ) => Promise<ProcessingResult> {
    return (eventId, familyId) => this.process(eventId, familyId);
  }

  /**
   * Process text content through Filter/Scribe/Registrar pipeline.
   */
  private async processTextContent(
    eventId: string,
    familyId: string
  ): Promise<void> {
    // Run Filter (if configured) to determine if message is relevant
    let shouldProcess = true;
    if (this.filter) {
      this.logger.debug({ eventId }, 'Running Filter');
      const filterResult = await this.filter(eventId, familyId);

      if (!filterResult.relevant) {
        // Message is not relevant - skip Scribe
        this.logger.info(
          {
            eventId,
            reason: filterResult.reason,
            tokensUsed: filterResult.tokensUsed,
          },
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
          {
            eventId,
            reason: filterResult.reason,
            tokensUsed: filterResult.tokensUsed,
          },
          'Message passed filter'
        );
      }
    }

    // Run Scribe (if configured and filter passed)
    let domainModel: ScribeDomainModel | undefined;
    if (this.scribe && shouldProcess) {
      this.logger.debug({ eventId }, 'Running Scribe');
      domainModel = await this.scribe(eventId, familyId);

      // Log extraction results
      if (domainModel) {
        this.logger.info(
          {
            eventId,
            people: domainModel.people.length,
            places: domainModel.places.length,
            events: domainModel.events.length,
            claims: domainModel.claims.length,
            questions: domainModel.questions.length,
            imageReferences: domainModel.imageReferences?.length || 0,
          },
          'Scribe extraction complete'
        );
      }
    }

    // Run Image Linker (if configured and we have a domain model)
    // This catches image references that Scribe may have missed
    if (this.imageLinker && domainModel) {
      const linkResult = await this.imageLinker(eventId, familyId);

      if (linkResult.linked && linkResult.imageId && linkResult.referenceType) {
        // Check if Scribe already detected this image reference
        const existingRefs = domainModel.imageReferences || [];
        const alreadyDetected = existingRefs.some(
          (ref) => ref.imageId === linkResult.imageId
        );

        if (!alreadyDetected) {
          // Augment domain model with the image reference
          domainModel.imageReferences = [
            ...existingRefs,
            {
              imageId: linkResult.imageId,
              referenceType: linkResult.referenceType,
              confidence: Confidence.MEDIUM, // Intern detection is medium confidence
            },
          ];

          this.logger.info(
            {
              eventId,
              imageId: linkResult.imageId,
              referenceType: linkResult.referenceType,
              reason: linkResult.reason,
              tokensUsed: linkResult.tokensUsed,
            },
            'Image Linker detected reference (Scribe missed)'
          );

          // Log the augmentation
          await this.eventLog.log({
            familyId,
            eventType: 'image_linked',
            eventCategory: 'system_event',
            actor: 'intern',
            actorType: 'system',
            sourceEventId: eventId,
            eventData: {
              imageId: linkResult.imageId,
              referenceType: linkResult.referenceType,
              reason: linkResult.reason,
              tokensUsed: linkResult.tokensUsed,
              source: 'intern_fallback',
            },
          });
        } else {
          this.logger.debug(
            { eventId, imageId: linkResult.imageId },
            'Image Linker confirmed Scribe detection'
          );
        }
      }
    }

    // Run Registrar (if configured and we have a domain model)
    if (this.registrar && domainModel) {
      this.logger.debug({ eventId }, 'Running Registrar');
      await this.registrar(domainModel, familyId);
    }
  }

  /**
   * Create an Image record for a media event and notify for async Curator analysis.
   */
  private async createImageRecord(
    eventId: string,
    familyId: string,
    event: {
      eventType: string;
      source: string;
      contentOriginal?: string;
      languageOriginal?: string;
      metadata?: Record<string, unknown>;
      actorDisplayName?: string;
    }
  ): Promise<string | undefined> {
    const metadata = event.metadata || {};
    const fileId = (metadata.fileId as string) || '';
    const fileUniqueId = (metadata.fileUniqueId as string) || '';

    if (!fileUniqueId) {
      this.logger.warn(
        { eventId, eventType: event.eventType },
        'Media event missing fileUniqueId, skipping image creation'
      );
      return undefined;
    }

    // Check if we already have an Image record for this file
    let image = await this.imageRepo.findByExternalFileId(
      familyId,
      event.source,
      fileUniqueId
    );

    if (image) {
      this.logger.debug(
        { eventId, imageId: image.id },
        'Image record already exists'
      );
      return image.id;
    }

    // Determine file type based on event type
    let fileType: 'photo' | 'document' | 'video';
    if (event.eventType === 'photo') {
      fileType = 'photo';
    } else if (event.eventType === 'video') {
      fileType = 'video';
    } else {
      fileType = 'document';
    }

    // Create a new Image record
    this.logger.debug({ eventId, fileType, fileId }, 'Creating image record');
    image = await this.imageRepo.createFromEvent(familyId, eventId, {
      source: event.source,
      externalFileId: fileUniqueId,
      fileType,
      fileSizeBytes: metadata.fileSize as number | undefined,
      captionOriginal: event.contentOriginal,
      languageOriginal: event.languageOriginal,
      sharedBy: event.actorDisplayName,
    });

    this.logger.info(
      { eventId, imageId: image.id, fileType },
      'Image record created'
    );

    // Notify for async Curator analysis (non-blocking)
    if (this.onImageCreated) {
      try {
        this.onImageCreated(familyId, image.id, eventId);
      } catch (error) {
        // Don't fail processing if callback fails
        this.logger.warn(
          { imageId: image.id, error },
          'onImageCreated callback failed'
        );
      }
    }

    return image.id;
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
      await this.questionRepo.markAnswered(
        familyId,
        question.id,
        answerEventId
      );

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
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.warn(
        { familyId, replyToExternalId, error: errorMessage },
        'Answer detection failed (non-fatal)'
      );
    }
  }
}
