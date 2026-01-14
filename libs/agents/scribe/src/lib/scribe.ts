import type { ScribeDomainModel } from '@sobremesa/shared-types';
import {
  ConversationEventRepository,
  ClaimRepository,
  QuestionRepository,
  FamilyRepository,
  ImageRepository,
} from '@sobremesa/database';
import { createLogger } from '@sobremesa/shared-utils';
import type pino from 'pino';
import { buildSystemPrompt, buildUserMessage } from './prompt-builder';
import { parseScribeResponse } from './response-parser';
import { buildScribeContext } from './context-builder';
import { DEFAULT_SCRIBE_CONFIG, type ScribeConfig } from './types';

/**
 * Anthropic client interface.
 * Using unknown to avoid TypeScript version mismatches across workspace packages.
 * The actual Anthropic client from @anthropic-ai/sdk should be passed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnthropicClient = any;

/**
 * Options for creating a ScribeAgent.
 */
export interface ScribeAgentOptions {
  /** Anthropic client (from @anthropic-ai/sdk) */
  anthropic: AnthropicClient;
  /** Conversation event repository */
  eventRepo?: ConversationEventRepository;
  /** Claim repository */
  claimRepo?: ClaimRepository;
  /** Question repository */
  questionRepo?: QuestionRepository;
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
 * The Scribe agent extracts entities, claims, and questions from messages.
 * It processes one message at a time and outputs a domain model.
 * Note: Entity matching (people/places) is handled by Registrar, not Scribe.
 */
export class ScribeAgent {
  private anthropic: AnthropicClient;
  private eventRepo: ConversationEventRepository;
  private claimRepo: ClaimRepository;
  private questionRepo: QuestionRepository;
  private familyRepo: FamilyRepository;
  private imageRepo: ImageRepository;
  private logger: pino.Logger;
  private config: ScribeConfig;

  constructor(options: ScribeAgentOptions) {
    this.anthropic = options.anthropic;
    this.eventRepo = options.eventRepo || new ConversationEventRepository();
    this.claimRepo = options.claimRepo || new ClaimRepository();
    this.questionRepo = options.questionRepo || new QuestionRepository();
    this.familyRepo = options.familyRepo || new FamilyRepository();
    this.imageRepo = options.imageRepo || new ImageRepository();
    this.logger = options.logger || createLogger({ name: 'scribe' });
    this.config = { ...DEFAULT_SCRIBE_CONFIG, ...options.config };
  }

  /**
   * Process a conversation event and extract a domain model.
   * This is the ScribeProcessor function for MessageProcessor.
   */
  async process(eventId: string, familyId: string): Promise<ScribeDomainModel> {
    this.logger.info({ eventId, familyId }, 'Scribe processing started');

    // Load the conversation event
    const event = await this.eventRepo.findById(familyId, eventId);
    if (!event) {
      throw new Error(`Event not found: ${eventId}`);
    }

    if (!event.contentOriginal) {
      this.logger.debug(
        { eventId },
        'Event has no content, returning empty model'
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

    // Build context from database
    // Note: People/places removed - Registrar handles entity matching
    const context = await buildScribeContext(familyId, event.conversationId, {
      eventRepo: this.eventRepo,
      claimRepo: this.claimRepo,
      questionRepo: this.questionRepo,
      imageRepo: this.imageRepo,
    });

    // Build prompts
    const systemPrompt = buildSystemPrompt(config);
    const userMessage = buildUserMessage(
      event.contentOriginal,
      event.actorDisplayName || event.actorUsername || 'Unknown',
      context
    );

    // Call Claude API
    this.logger.debug({ eventId }, 'Calling Claude API');
    const startTime = Date.now();

    try {
      const response = await this.anthropic.messages.create({
        model: config.model,
        max_tokens: config.maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });

      const duration = Date.now() - startTime;
      this.logger.info({ eventId, duration }, 'Claude API response received');

      // Extract text content from response
      const textContent = response.content.find(
        (c: { type: string; text?: string }) => c.type === 'text'
      );
      if (!textContent || textContent.type !== 'text' || !textContent.text) {
        throw new Error('No text content in Claude response');
      }

      // Parse response into domain model
      const domainModel = parseScribeResponse(
        textContent.text,
        eventId,
        familyId
      );

      this.logger.info(
        {
          eventId,
          people: domainModel.people.length,
          places: domainModel.places.length,
          events: domainModel.events.length,
          claims: domainModel.claims.length,
          questions: domainModel.questions.length,
        },
        'Scribe extraction complete'
      );

      return domainModel;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(
        { eventId, error, duration },
        'Scribe processing failed'
      );
      throw error;
    }
  }

  /**
   * Load family configuration for cultural terms and other settings.
   */
  private async loadFamilyConfig(
    familyId: string
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
    familyId: string
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
      questions: [],
      answers: [],
      conflicts: [],
      imageReferences: [],
      detectedLanguage: 'en',
    };
  }
}
