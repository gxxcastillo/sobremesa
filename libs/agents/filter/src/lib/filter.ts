import { ConversationEventRepository } from '@sobremesa/database';
import { createLogger } from '@sobremesa/shared-utils';
import type pino from 'pino';

/**
 * Anthropic client interface.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnthropicClient = any;

/**
 * Result of the message filter.
 */
export interface FilterResult {
  /** Whether the message should be processed by Scribe */
  relevant: boolean;
  /** Reason for the decision (for logging/debugging) */
  reason: string;
  /** Tokens used for this filter call */
  tokensUsed?: number;
}

/**
 * Configuration for the message filter.
 */
export interface FilterConfig {
  /** Model to use for filtering (default: claude-3-haiku) */
  model: string;
  /** Maximum tokens for response */
  maxTokens: number;
  /** Number of recent messages for context */
  recentMessageCount: number;
}

export const DEFAULT_FILTER_CONFIG: FilterConfig = {
  model: 'claude-3-5-haiku-20241022',
  maxTokens: 100,
  recentMessageCount: 2,
};

/**
 * Options for creating a MessageFilterAgent.
 */
export interface MessageFilterAgentOptions {
  /** Anthropic client (from @anthropic-ai/sdk) */
  anthropic: AnthropicClient;
  /** Conversation event repository */
  eventRepo?: ConversationEventRepository;
  /** Logger instance */
  logger?: pino.Logger;
  /** Filter configuration overrides */
  config?: Partial<FilterConfig>;
}

const SYSTEM_PROMPT = `You are a message filter for a family history application. Your job is to decide if a message might contain family history information worth extracting.

RELEVANT messages (process these):
- Stories about family members, ancestors, or relatives
- Mentions of births, deaths, marriages, or other life events
- References to places where family lived or traveled
- Descriptions of family traditions, recipes, or customs
- Old photos being discussed or described
- Memories or anecdotes about family members
- Genealogical information (dates, relationships, names)
- Immigration or migration stories
- Family business or work history

NOT RELEVANT messages (skip these):
- General greetings ("Hi!", "Good morning everyone!")
- Logistics and scheduling ("What time is dinner?", "See you tomorrow")
- Reactions and acknowledgments ("Thanks!", "OK", "👍", "LOL")
- Off-topic conversations (weather, sports, news)
- Technical chat issues ("Can you hear me?", "Is this working?")
- Simple confirmations without context ("Yes", "No", "Sure")

IMPORTANT: When in doubt, mark as RELEVANT. It's better to process an irrelevant message than miss family history.

Respond with ONLY a JSON object:
{"relevant": true/false, "reason": "brief explanation"}`;

/**
 * The MessageFilterAgent uses Haiku to quickly determine if a message
 * is relevant to family history before running the full Scribe extraction.
 */
export class MessageFilterAgent {
  private anthropic: AnthropicClient;
  private eventRepo: ConversationEventRepository;
  private logger: pino.Logger;
  private config: FilterConfig;

  constructor(options: MessageFilterAgentOptions) {
    this.anthropic = options.anthropic;
    this.eventRepo = options.eventRepo || new ConversationEventRepository();
    this.logger = options.logger || createLogger({ name: 'filter' });
    this.config = { ...DEFAULT_FILTER_CONFIG, ...options.config };
  }

  /**
   * Filter a message to determine if it should be processed.
   */
  async filter(eventId: string, familyId: string): Promise<FilterResult> {
    try {
      // Load the event
      const event = await this.eventRepo.findById(familyId, eventId);
      if (!event) {
        this.logger.warn({ eventId }, 'Event not found for filtering');
        return { relevant: true, reason: 'Event not found, defaulting to relevant' };
      }

      // Skip non-text events (photos, documents) - let Scribe handle those
      if (event.eventType !== 'message') {
        return { relevant: true, reason: `Non-text event type: ${event.eventType}` };
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

      // Get recent messages for context
      const recentMessages = await this.eventRepo.findRecent(
        familyId,
        event.conversationId,
        this.config.recentMessageCount + 1 // +1 to include current, then filter it out
      );

      // Build context from recent messages (excluding current)
      const contextMessages = recentMessages
        .filter((m) => m.id !== eventId && m.contentOriginal)
        .slice(0, this.config.recentMessageCount)
        .map((m) => `- ${m.actorDisplayName || 'Someone'}: "${m.contentOriginal}"`)
        .join('\n');

      // Build user message
      const userMessage = contextMessages
        ? `Recent conversation:\n${contextMessages}\n\nNew message to evaluate:\n"${messageText}"`
        : `Message to evaluate:\n"${messageText}"`;

      // Call Haiku
      const response = await this.anthropic.messages.create({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      });

      // Parse response
      const content = response.content[0];
      if (content.type !== 'text') {
        this.logger.warn({ eventId }, 'Unexpected response type, defaulting to relevant');
        return { relevant: true, reason: 'Unexpected response type' };
      }

      const result = this.parseResponse(content.text);

      // Calculate tokens used
      const tokensUsed =
        (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);

      this.logger.debug(
        {
          eventId,
          relevant: result.relevant,
          reason: result.reason,
          tokensUsed,
          messagePreview: messageText.slice(0, 50),
        },
        'Filter result'
      );

      return { ...result, tokensUsed };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error({ eventId, error: errorMessage }, 'Filter error, defaulting to relevant');
      // Default to relevant on error - don't skip messages due to filter failures
      return { relevant: true, reason: `Filter error: ${errorMessage}` };
    }
  }

  /**
   * Parse the JSON response from Haiku.
   */
  private parseResponse(text: string): { relevant: boolean; reason: string } {
    try {
      // Try to extract JSON from the response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { relevant: true, reason: 'Could not parse response, defaulting to relevant' };
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // Validate and extract fields
      const relevant = typeof parsed.relevant === 'boolean' ? parsed.relevant : true;
      const reason = typeof parsed.reason === 'string' ? parsed.reason : 'No reason provided';

      return { relevant, reason };
    } catch {
      return { relevant: true, reason: 'JSON parse error, defaulting to relevant' };
    }
  }
}
