import { loadPrompt } from '@sobremesa/prompts';
import {
  ConversationEventRepository,
  ImageRepository,
} from '@sobremesa/database';
import { createLogger } from '@sobremesa/shared-utils';
import type { AIProvider } from '@sobremesa/ai-provider';
import type pino from 'pino';
import type { Image } from '@sobremesa/shared-types';
import type { MessageContext } from '@sobremesa/queue';

/**
 * Result of a message filter task.
 */
export interface FilterResult {
  /** Whether the message should be processed by Scribe */
  relevant: boolean;
  /** Reason for the decision (for logging/debugging) */
  reason: string;
  /** Detected language of the message (en, es) */
  language?: string;
  /** Tokens used for this call */
  tokensUsed?: number;
}

/**
 * Routing action for a message.
 */
export type RoutingAction = 'ignore' | 'admin' | 'scribe' | 'historian';

/**
 * Result of message routing.
 */
export interface RoutingResult {
  /** Where to route the message */
  action: RoutingAction;
  /** Subtype for admin actions */
  adminSubtype?: 'command' | 'status' | 'dm' | 'member_event' | 'mention';
  /** Reason for the routing decision */
  reason: string;
  /** Detected language of the message (en, es) */
  language?: string;
  /** Tokens used (if AI was called) */
  tokensUsed?: number;
}

/**
 * How a message references an image.
 */
export type ImageReferenceType =
  | 'describes'
  | 'identifies_people'
  | 'provides_context'
  | 'asks_about';

/**
 * Result of image-text linking task.
 */
export interface ImageLinkResult {
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
 * Configuration for the Intern agent.
 */
export interface InternConfig {
  /** Maximum tokens for response */
  maxTokens: number;
  /** Number of recent messages for context */
  recentMessageCount: number;
  /** Bot username for mention detection (without @) */
  botUsername?: string;
}

export const DEFAULT_INTERN_CONFIG: InternConfig = {
  maxTokens: 100,
  recentMessageCount: 5, // Enough context to see conversation continuations
};

/**
 * Options for creating an InternAgent.
 */
export interface InternAgentOptions {
  /** AI provider for completions */
  provider: AIProvider;
  /** Model to use */
  model: string;
  /** Conversation event repository */
  eventRepo?: ConversationEventRepository;
  /** Image repository */
  imageRepo?: ImageRepository;
  /** Logger instance */
  logger?: pino.Logger;
  /** Configuration overrides */
  config?: Partial<InternConfig>;
}

/**
 * NOTE: System prompts are now loaded from:
 * - /prompts/intern-filter.md (for message filtering)
 * - /prompts/intern-image-link.md (for image reference detection)
 */

/**
 * The Intern agent uses Haiku for fast, lightweight preprocessing tasks.
 * It handles quick checks and classifications before heavier agents run.
 */
export class InternAgent {
  private provider: AIProvider;
  private model: string;
  private eventRepo: ConversationEventRepository;
  private imageRepo: ImageRepository;
  private logger: pino.Logger;
  private config: InternConfig;

  constructor(options: InternAgentOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.eventRepo = options.eventRepo || new ConversationEventRepository();
    this.imageRepo = options.imageRepo || new ImageRepository();
    this.logger = options.logger || createLogger({ name: 'intern' });
    this.config = { ...DEFAULT_INTERN_CONFIG, ...options.config };
  }

  /**
   * Filter a message to determine if it should be processed by Scribe.
   * Optional context parameter allows sharing pre-fetched context from MessageProcessor.
   */
  async filter(
    eventId: string,
    familyId: string,
    context?: MessageContext,
  ): Promise<FilterResult> {
    try {
      // Load the event
      const event = await this.eventRepo.findById(familyId, eventId);
      if (!event) {
        this.logger.warn({ eventId }, 'Event not found for filtering');
        return {
          relevant: true,
          reason: 'Event not found, defaulting to relevant',
        };
      }

      // Skip non-text events (photos, documents) - let Scribe handle those
      if (event.eventType !== 'message') {
        return {
          relevant: true,
          reason: `Non-text event type: ${event.eventType}`,
        };
      }

      // Skip empty messages
      const messageText = event.contentOriginal?.trim();
      if (!messageText) {
        return { relevant: false, reason: 'Empty message' };
      }

      // Skip very short messages (likely reactions)
      if (messageText.length < 3) {
        return { relevant: false, reason: 'Message too short' };
      }

      // Fast path: Messages starting with conjunctions are continuations
      const lowerText = messageText.toLowerCase();
      if (
        lowerText.startsWith('and ') ||
        lowerText.startsWith('but ') ||
        lowerText.startsWith('or ') ||
        lowerText.startsWith('also ')
      ) {
        return {
          relevant: true,
          reason: 'Continuation (starts with conjunction)',
        };
      }

      // Use pre-fetched context if provided, otherwise fetch from DB
      let contextMessages: string;
      if (context) {
        // Use shared context (excluding current message)
        contextMessages = context.recentMessages
          .filter((m) => m.id !== eventId)
          .slice(0, this.config.recentMessageCount)
          .map((m) => `- ${m.senderName}: "${m.content}"`)
          .join('\n');
      } else {
        // Fallback: fetch from DB
        const recentMessages = await this.eventRepo.findRecent(
          familyId,
          event.conversationId,
          this.config.recentMessageCount + 1, // +1 to include current, then filter it out
        );
        contextMessages = recentMessages
          .filter((m) => m.id !== eventId && m.contentOriginal)
          .slice(0, this.config.recentMessageCount)
          .map(
            (m) =>
              `- ${m.actorDisplayName || 'Someone'}: "${m.contentOriginal}"`,
          )
          .join('\n');
      }

      // Build user message
      const userMessage = contextMessages
        ? `Recent conversation:\n${contextMessages}\n\nNew message to evaluate:\n"${messageText}"`
        : `Message to evaluate:\n"${messageText}"`;

      // Call AI provider
      const response = await this.provider.complete({
        model: this.model,
        maxTokens: this.config.maxTokens,
        system: loadPrompt('internFilter'),
        messages: [{ role: 'user', content: userMessage }],
      });

      // Parse response
      const result = this.parseFilterResponse(response.content);

      // Get tokens used
      const tokensUsed = response.usage.totalTokens;

      this.logger.debug(
        {
          eventId,
          relevant: result.relevant,
          reason: result.reason,
          tokensUsed,
          messagePreview: messageText.slice(0, 50),
        },
        'Filter result',
      );

      return { ...result, tokensUsed };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        { eventId, error: errorMessage },
        'Filter error, defaulting to relevant',
      );
      // Default to relevant on error - don't skip messages due to filter failures
      return { relevant: true, reason: `Filter error: ${errorMessage}` };
    }
  }

  /**
   * Parse the JSON response from the filter prompt.
   */
  private parseFilterResponse(text: string): {
    relevant: boolean;
    reason: string;
    language?: string;
  } {
    try {
      // Try to extract JSON from the response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return {
          relevant: true,
          reason: 'Could not parse response, defaulting to relevant',
        };
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // Validate and extract fields
      const relevant =
        typeof parsed.relevant === 'boolean' ? parsed.relevant : true;
      const reason =
        typeof parsed.reason === 'string'
          ? parsed.reason
          : 'No reason provided';
      const language =
        typeof parsed.language === 'string' ? parsed.language : undefined;

      return { relevant, reason, language };
    } catch {
      return {
        relevant: true,
        reason: 'JSON parse error, defaulting to relevant',
      };
    }
  }

  /**
   * Check if a message references a recently shared image.
   * This helps Scribe understand when text messages are describing photos.
   * Optional context parameter allows sharing pre-fetched context from MessageProcessor.
   */
  async linkToImage(
    eventId: string,
    familyId: string,
    context?: MessageContext,
  ): Promise<ImageLinkResult> {
    try {
      // Load the event
      const event = await this.eventRepo.findById(familyId, eventId);
      if (!event) {
        this.logger.warn({ eventId }, 'Event not found for image linking');
        return { linked: false, reason: 'Event not found' };
      }

      // Only process text messages
      if (event.eventType !== 'message') {
        return {
          linked: false,
          reason: `Non-text event type: ${event.eventType}`,
        };
      }

      const messageText = event.contentOriginal?.trim();
      if (!messageText) {
        return { linked: false, reason: 'Empty message' };
      }

      // Use pre-fetched context if provided, otherwise fetch from DB
      let imageDescriptions: string;
      if (context && context.recentImages.length > 0) {
        // Use shared context images
        imageDescriptions = context.recentImages
          .map((img) => this.formatContextImageForPrompt(img))
          .join('\n');
      } else if (context && context.recentImages.length === 0) {
        return { linked: false, reason: 'No recent images in conversation' };
      } else {
        // Fallback: fetch from DB
        const recentImages = await this.imageRepo.findRecentInConversation(
          familyId,
          event.conversationId,
          5, // Check last 5 images
        );

        if (recentImages.length === 0) {
          return { linked: false, reason: 'No recent images in conversation' };
        }

        imageDescriptions = recentImages
          .map((img) => this.formatImageForPrompt(img))
          .join('\n');
      }

      // Build user message
      const userMessage = `Recent images:\n${imageDescriptions}\n\nMessage to evaluate:\n"${messageText}"`;

      // Call AI provider
      const response = await this.provider.complete({
        model: this.model,
        maxTokens: this.config.maxTokens,
        system: loadPrompt('internImageLink'),
        messages: [{ role: 'user', content: userMessage }],
      });

      // Parse response
      const result = this.parseImageLinkResponse(response.content);

      // Get tokens used
      const tokensUsed = response.usage.totalTokens;

      this.logger.debug(
        {
          eventId,
          linked: result.linked,
          imageId: result.imageId,
          referenceType: result.referenceType,
          reason: result.reason,
          tokensUsed,
          messagePreview: messageText.slice(0, 50),
        },
        'Image link result',
      );

      return { ...result, tokensUsed };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error({ eventId, error: errorMessage }, 'Image link error');
      return { linked: false, reason: `Error: ${errorMessage}` };
    }
  }

  /**
   * Format an image for the prompt context (from DB Image type).
   */
  private formatImageForPrompt(image: Image): string {
    const parts: string[] = [`[${image.id}]`];
    parts.push(image.fileType || 'image');

    if (image.sharedBy) {
      parts.push(`shared by ${image.sharedBy}`);
    }

    // Add analysis info if available
    const analysis = image.analysis as Record<string, unknown> | undefined;
    if (analysis?.description) {
      parts.push(`- "${analysis.description}"`);
    }

    if (image.peopleCount) {
      parts.push(`(${image.peopleCount} people visible)`);
    }

    if (image.estimatedEra) {
      parts.push(`(~${image.estimatedEra})`);
    }

    return parts.join(' ');
  }

  /**
   * Format an image from shared MessageContext for the prompt.
   */
  private formatContextImageForPrompt(
    image: MessageContext['recentImages'][number],
  ): string {
    const parts: string[] = [`[${image.id}]`];
    parts.push(image.fileType || 'image');

    if (image.sharedBy) {
      parts.push(`shared by ${image.sharedBy}`);
    }

    if (image.description) {
      parts.push(`- "${image.description}"`);
    }

    if (image.peopleCount) {
      parts.push(`(${image.peopleCount} people visible)`);
    }

    if (image.estimatedEra) {
      parts.push(`(~${image.estimatedEra})`);
    }

    return parts.join(' ');
  }

  /**
   * Check if the bot is mentioned in the message text.
   * Handles @username mentions (case-insensitive).
   * Uses negative lookbehind to avoid matching email-like patterns.
   */
  private isBotMentioned(messageText: string): boolean {
    if (!this.config.botUsername) {
      return false;
    }
    // Negative lookbehind (?<![a-zA-Z0-9]) ensures @ isn't preceded by alphanumeric
    // This prevents matching email-like patterns (email@bot.com)
    const mentionPattern = new RegExp(
      `(?<![a-zA-Z0-9])@${this.config.botUsername}\\b`,
      'i',
    );
    return mentionPattern.test(messageText);
  }

  /**
   * Check if a message contains a question.
   * Uses heuristics to detect question patterns.
   */
  private isQuestion(text: string): boolean {
    const trimmed = text.trim();

    // Ends with question mark
    if (trimmed.endsWith('?')) {
      return true;
    }

    // Starts with question words
    const questionStarters =
      /^(who|what|when|where|why|how|is|are|was|were|did|do|does|can|could|would|will|tell me|do you know|does anyone)/i;
    if (questionStarters.test(trimmed)) {
      return true;
    }

    // Contains question-like phrases
    const questionPhrases = /\b(know about|remember|recall|tell me about)\b/i;
    if (questionPhrases.test(trimmed)) {
      return true;
    }

    return false;
  }

  /**
   * Check if a question is about the bot itself (meta-question).
   * These should go to admin, not historian.
   */
  private isMetaQuestion(text: string): boolean {
    const metaPatterns = [
      // Questions about bot behavior/functionality
      /\b(you|your|you're|bot)\b.*\b(working|doing|send|sending|respond|responding|greeting|message|broken|bug|error|issue)/i,
      // "why aren't you..." / "why don't you..."
      /\bwhy\s+(aren't|arent|are\s*n[o']t|don't|dont|do\s*n[o']t)\s+you\b/i,
      // "why didn't you..."
      /\bwhy\s+(didn't|didnt|did\s*n[o']t)\s+you\b/i,
      // "what's wrong with you"
      /\bwhat('s|s|\s+is)\s+wrong\s+with\s+you\b/i,
      // "are you working/ok/broken"
      /\bare\s+you\s+(working|ok|okay|broken|bugged|down)\b/i,
      // "can you hear me" / "do you work"
      /\b(can|do)\s+you\s+(hear|see|work|respond)\b/i,
    ];
    return metaPatterns.some((pattern) => pattern.test(text));
  }

  /**
   * Parse the JSON response from the image link prompt.
   */
  private parseImageLinkResponse(text: string): ImageLinkResult {
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { linked: false, reason: 'Could not parse response' };
      }

      const parsed = JSON.parse(jsonMatch[0]);

      const linked = typeof parsed.linked === 'boolean' ? parsed.linked : false;
      const reason =
        typeof parsed.reason === 'string'
          ? parsed.reason
          : 'No reason provided';

      if (!linked) {
        return { linked: false, reason };
      }

      // Validate image_id
      const imageId =
        typeof parsed.image_id === 'string' ? parsed.image_id : undefined;
      if (!imageId) {
        return { linked: false, reason: 'No image ID in response' };
      }

      // Validate reference_type
      const validTypes: ImageReferenceType[] = [
        'describes',
        'identifies_people',
        'provides_context',
        'asks_about',
      ];
      const referenceType = validTypes.includes(parsed.reference_type)
        ? (parsed.reference_type as ImageReferenceType)
        : 'describes';

      return { linked: true, imageId, referenceType, reason };
    } catch {
      return { linked: false, reason: 'JSON parse error' };
    }
  }

  /**
   * Route a message to the appropriate handler.
   * Optional context parameter allows sharing pre-fetched context from MessageProcessor.
   *
   * Routing logic:
   * 1. Commands (/sobremesa, /status) → admin
   * 2. Private messages (DMs) → admin
   * 3. Member events → admin
   * 4. Spam/noise (via filter) → ignore
   * 5. Everything else → scribe
   */
  async route(
    eventId: string,
    familyId: string,
    context?: MessageContext,
  ): Promise<RoutingResult> {
    try {
      // Load the event
      const event = await this.eventRepo.findById(familyId, eventId);
      if (!event) {
        this.logger.warn({ eventId }, 'Event not found for routing');
        return {
          action: 'scribe',
          reason: 'Event not found, defaulting to scribe',
        };
      }

      const messageText = event.contentOriginal?.trim() || '';
      const chatType = (event.metadata as Record<string, unknown>)?.chatType as
        | string
        | undefined;

      // Check for commands (deterministic routing)
      if (messageText.startsWith('/')) {
        const command = messageText.split(/\s+/)[0].toLowerCase();

        if (command === '/sobremesa' || command.startsWith('/sobremesa@')) {
          this.logger.debug(
            { eventId, command },
            'Routing to admin: sobremesa command',
          );
          return {
            action: 'admin',
            adminSubtype: 'status', // In registered chat, /sobremesa shows status
            reason: `Command: ${command}`,
          };
        }

        if (command === '/status' || command.startsWith('/status@')) {
          this.logger.debug(
            { eventId, command },
            'Routing to admin: status command',
          );
          return {
            action: 'admin',
            adminSubtype: 'status',
            reason: `Command: ${command}`,
          };
        }

        // Unknown command - ignore (or could route to admin)
        this.logger.debug({ eventId, command }, 'Ignoring unknown command');
        return {
          action: 'ignore',
          reason: `Unknown command: ${command}`,
        };
      }

      // Check for @ mentions of the bot (deterministic routing)
      if (this.config.botUsername && this.isBotMentioned(messageText)) {
        // If it's a question, check if it's about the bot itself
        if (this.isQuestion(messageText)) {
          // Meta questions about bot behavior go to admin
          if (this.isMetaQuestion(messageText)) {
            this.logger.debug(
              { eventId },
              'Routing to admin: meta question about bot',
            );
            return {
              action: 'admin',
              adminSubtype: 'mention',
              reason: 'Meta question about bot behavior',
            };
          }
          // Regular family history questions go to historian
          this.logger.debug(
            { eventId },
            'Routing to historian: question to bot',
          );
          return {
            action: 'historian',
            reason: 'Question directed at bot',
          };
        }
        // Non-question mentions go to admin
        this.logger.debug({ eventId }, 'Routing to admin: bot mentioned');
        return {
          action: 'admin',
          adminSubtype: 'mention',
          reason: 'Bot mentioned directly',
        };
      }

      // Check for private messages (DMs)
      if (chatType === 'private') {
        this.logger.debug({ eventId }, 'Routing to admin: private message');
        return {
          action: 'admin',
          adminSubtype: 'dm',
          reason: 'Private message (DM)',
        };
      }

      // Check for member events
      if (event.eventType === 'join' || event.eventType === 'leave') {
        this.logger.debug(
          { eventId, eventType: event.eventType },
          'Routing to admin: member event',
        );
        return {
          action: 'admin',
          adminSubtype: 'member_event',
          reason: `Member event: ${event.eventType}`,
        };
      }

      // For non-text events (photos, documents), route to scribe
      if (event.eventType !== 'message') {
        return {
          action: 'scribe',
          reason: `Non-text event type: ${event.eventType}`,
        };
      }

      // Use filter to determine if message is relevant
      const filterResult = await this.filter(eventId, familyId, context);

      if (!filterResult.relevant) {
        return {
          action: 'ignore',
          reason: filterResult.reason,
          language: filterResult.language,
          tokensUsed: filterResult.tokensUsed,
        };
      }

      // Route to scribe for processing
      return {
        action: 'scribe',
        reason: filterResult.reason,
        language: filterResult.language,
        tokensUsed: filterResult.tokensUsed,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        { eventId, error: errorMessage },
        'Routing error, defaulting to scribe',
      );
      return {
        action: 'scribe',
        reason: `Routing error: ${errorMessage}`,
      };
    }
  }
}
