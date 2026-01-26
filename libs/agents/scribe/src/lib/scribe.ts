import type { ScribeDomainModel } from '@sobremesa/shared-types';
import {
  ConversationEventRepository,
  FamilyRepository,
  ImageRepository,
} from '@sobremesa/database';
import { createLogger } from '@sobremesa/shared-utils';
import type { AIProvider } from '@sobremesa/ai-provider';
import type { MessageContext } from '@sobremesa/queue';
import type pino from 'pino';
import { buildSystemPrompt, buildUserMessage } from './prompt-builder';
import { parseScribeResponse } from './response-parser';
import { buildScribeContext } from './context-builder';
import { DEFAULT_SCRIBE_CONFIG, type ScribeConfig } from './types';
import { SCRIBE_JSON_SCHEMA } from './schema';

/**
 * Options for creating a ScribeAgent.
 */
export interface ScribeAgentOptions {
  /** AI provider for completions */
  provider: AIProvider;
  /** Model to use */
  model: string;
  /** Conversation event repository */
  eventRepo?: ConversationEventRepository;
  /** Family repository */
  familyRepo?: FamilyRepository;
  /** Image repository (for recent images context) */
  imageRepo?: ImageRepository;
  /** Logger instance */
  logger?: pino.Logger;
  /** Scribe configuration overrides */
  config?: Partial<ScribeConfig>;
}

/**
 * The Scribe agent extracts entities and claims from messages.
 * It processes one message at a time and outputs a domain model.
 * Note: Entity matching is handled by Registrar. Question generation is handled downstream.
 */
export class ScribeAgent {
  private provider: AIProvider;
  private model: string;
  private eventRepo: ConversationEventRepository;
  private familyRepo: FamilyRepository;
  private imageRepo: ImageRepository;
  private logger: pino.Logger;
  private config: ScribeConfig;

  constructor(options: ScribeAgentOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.eventRepo = options.eventRepo || new ConversationEventRepository();
    this.familyRepo = options.familyRepo || new FamilyRepository();
    this.imageRepo = options.imageRepo || new ImageRepository();
    this.logger = options.logger || createLogger({ name: 'scribe' });
    this.config = { ...DEFAULT_SCRIBE_CONFIG, ...options.config };
  }

  /**
   * Process a conversation event and extract a domain model.
   * This is the ScribeProcessor function for MessageProcessor.
   * Optional preloadedContext allows sharing pre-fetched context from MessageProcessor.
   */
  async process(
    eventId: string,
    familyId: string,
    preloadedContext?: MessageContext,
  ): Promise<ScribeDomainModel> {
    this.logger.info({ eventId, familyId }, 'Scribe processing started');

    // Load the conversation event
    const event = await this.eventRepo.findById(familyId, eventId);
    if (!event) {
      throw new Error(`Event not found: ${eventId}`);
    }

    if (!event.contentOriginal) {
      this.logger.debug(
        { eventId },
        'Event has no content, returning empty model',
      );
      return this.createEmptyModel(eventId, familyId);
    }

    // Load family config for cultural terms
    const familyConfig = await this.loadFamilyConfig(familyId);
    const config = {
      ...this.config,
      culturalTerms: [
        ...this.config.culturalTerms,
        ...(familyConfig?.culturalTerms || []),
      ],
    };

    // Build context (use preloaded if available, otherwise fetch from DB)
    // Note: People/places removed - Registrar handles entity matching
    const context = await buildScribeContext(
      familyId,
      event.conversationId,
      {
        eventRepo: this.eventRepo,
        imageRepo: this.imageRepo,
      },
      undefined, // options
      preloadedContext,
    );

    // Build prompts
    const systemPrompt = buildSystemPrompt(config);
    const userMessage = buildUserMessage(
      event.contentOriginal,
      event.actorDisplayName || event.actorUsername || 'Unknown',
      context,
    );

    // Call AI provider
    this.logger.debug({ eventId, model: this.model }, 'Calling AI provider');
    const startTime = Date.now();

    try {
      const response = await this.provider.complete({
        model: this.model,
        maxTokens: config.maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
        responseFormat: {
          type: 'json_schema',
          json_schema: SCRIBE_JSON_SCHEMA,
        },
      });

      const duration = Date.now() - startTime;
      this.logger.info(
        { eventId, duration, tokens: response.usage.totalTokens },
        'AI provider response received',
      );

      // Parse response into domain model
      const domainModel = parseScribeResponse(
        response.content,
        eventId,
        familyId,
      );

      return domainModel;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(
        { eventId, error, duration },
        'Scribe processing failed',
      );
      throw error;
    }
  }

  /**
   * Load family configuration for cultural terms and other settings.
   */
  private async loadFamilyConfig(
    familyId: string,
  ): Promise<{ culturalTerms?: string[] } | null> {
    try {
      const family = await this.familyRepo.findById(familyId);
      if (!family?.config) return null;

      const config = family.config as Record<string, unknown>;
      return {
        culturalTerms: Array.isArray(config.culturalTerms)
          ? config.culturalTerms
          : [],
      };
    } catch {
      return null;
    }
  }

  /**
   * Create an empty domain model.
   */
  private createEmptyModel(
    eventId: string,
    familyId: string,
  ): ScribeDomainModel {
    return {
      sourceEventId: eventId,
      familyId,
      processedAt: new Date(),
      people: [],
      places: [],
      events: [],
      relationships: [],
      claims: [],
      imageReferences: [],
      detectedLanguage: 'en',
    };
  }
}
