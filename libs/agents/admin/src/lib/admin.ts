import {
  ConversationEventRepository,
  FamilyRepository,
  EventLogRepository,
} from '@sobremesa/database';
import { createLogger } from '@sobremesa/shared-utils';
import type pino from 'pino';
import {
  BotRole,
  type Family,
  type FamilyConfig,
  type MessageSender,
  type SupportedLanguage,
  DEFAULT_LANGUAGE,
} from '@sobremesa/shared-types';
import {
  formatHelpMessage,
  formatMentionMessage,
  formatStatusMessage,
} from './messages';

export type { MessageSender };

/**
 * Options for AdminAgent.
 */
export interface AdminAgentOptions {
  /** Message sender (typically BotManager) */
  messageSender: MessageSender;
  /** Conversation event repository */
  eventRepo?: ConversationEventRepository;
  /** Family repository */
  familyRepo?: FamilyRepository;
  /** Event log repository */
  eventLog?: EventLogRepository;
  /** Logger instance */
  logger?: pino.Logger;
}

/**
 * Admin action types that can be handled.
 */
export type AdminActionType =
  | 'command'
  | 'status'
  | 'dm'
  | 'member_event'
  | 'mention';

/**
 * Result of handling an admin action.
 */
export interface AdminHandleResult {
  success: boolean;
  action: AdminActionType;
  messageSent?: boolean;
  error?: string;
}

/**
 * The Admin agent handles administrative messages:
 * - Status commands (/sobremesa, /status in registered chats)
 * - Direct messages (DMs) with help info
 * - Member events (welcomes, etc.)
 *
 * Stateless agent that processes events and sends replies.
 */
export class AdminAgent {
  private messageSender: MessageSender;
  private eventRepo: ConversationEventRepository;
  private familyRepo: FamilyRepository;
  private eventLog: EventLogRepository;
  private logger: pino.Logger;

  constructor(options: AdminAgentOptions) {
    this.messageSender = options.messageSender;
    this.eventRepo = options.eventRepo || new ConversationEventRepository();
    this.familyRepo = options.familyRepo || new FamilyRepository();
    this.eventLog = options.eventLog || new EventLogRepository();
    this.logger = options.logger || createLogger({ name: 'admin' });
  }

  /**
   * Handle an admin-routed event.
   *
   * @param eventId - The conversation event ID
   * @param familyId - The family ID
   * @param subtype - The admin action subtype from Intern routing
   */
  async handle(
    eventId: string,
    familyId: string,
    subtype: AdminActionType,
  ): Promise<AdminHandleResult> {
    this.logger.info({ eventId, familyId, subtype }, 'Handling admin action');

    try {
      switch (subtype) {
        case 'status':
        case 'command':
          return await this.handleStatusCommand(eventId, familyId);
        case 'dm':
          return await this.handleDirectMessage(eventId, familyId);
        case 'member_event':
          return await this.handleMemberEvent(eventId, familyId);
        case 'mention':
          return await this.handleMention(eventId, familyId);
        default:
          this.logger.warn({ subtype }, 'Unknown admin subtype');
          return { success: false, action: subtype, error: 'Unknown subtype' };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        { eventId, familyId, subtype, error: errorMessage },
        'Admin action failed',
      );
      return { success: false, action: subtype, error: errorMessage };
    }
  }

  /**
   * Handle /sobremesa or /status commands - show family status.
   */
  private async handleStatusCommand(
    eventId: string,
    familyId: string,
  ): Promise<AdminHandleResult> {
    // Load the event to get chat info for reply
    const event = await this.eventRepo.findById(familyId, eventId);
    if (!event) {
      return { success: false, action: 'status', error: 'Event not found' };
    }

    // Load family info
    const family = await this.familyRepo.findById(familyId);
    if (!family) {
      return { success: false, action: 'status', error: 'Family not found' };
    }

    // Get stats for the family
    const stats = await this.getFamilyStats(familyId);

    // Build status message
    const statusMessage = this.formatStatus(family, stats);

    // Get external message ID to reply to
    const externalMessageId = event.externalEventId
      ? parseInt(event.externalEventId, 10)
      : undefined;

    // Send reply
    await this.messageSender.sendMessage(BotRole.ADMIN, {
      chatId: event.conversationId,
      text: statusMessage,
      replyToMessageId:
        externalMessageId && !isNaN(externalMessageId)
          ? externalMessageId
          : undefined,
    });

    // Log the action
    await this.eventLog.log({
      familyId,
      eventType: 'event_processed',
      eventCategory: 'bot_action',
      actor: 'admin',
      actorType: 'system',
      eventData: { eventId, stats, action: 'status_shown' },
    });

    return { success: true, action: 'status', messageSent: true };
  }

  /**
   * Handle direct messages - show help info.
   */
  private async handleDirectMessage(
    eventId: string,
    familyId: string,
  ): Promise<AdminHandleResult> {
    const event = await this.eventRepo.findById(familyId, eventId);
    if (!event) {
      return { success: false, action: 'dm', error: 'Event not found' };
    }

    // Get family config for language
    const family = await this.familyRepo.findById(familyId);
    const language = this.getLanguageFromConfig(family?.config);

    const helpMessage = formatHelpMessage(language);

    await this.messageSender.sendMessage(BotRole.ADMIN, {
      chatId: event.conversationId,
      text: helpMessage,
    });

    return { success: true, action: 'dm', messageSent: true };
  }

  /**
   * Handle member events - welcome new members, etc.
   */
  private async handleMemberEvent(
    eventId: string,
    familyId: string,
  ): Promise<AdminHandleResult> {
    const event = await this.eventRepo.findById(familyId, eventId);
    if (!event) {
      return {
        success: false,
        action: 'member_event',
        error: 'Event not found',
      };
    }

    // For now, just log member events without sending a message
    // We could add welcome messages for new members in the future
    this.logger.info(
      { eventId, familyId, eventType: event.eventType },
      'Member event processed (no action taken)',
    );

    await this.eventLog.log({
      familyId,
      eventType: 'event_processed',
      eventCategory: 'bot_action',
      actor: 'admin',
      actorType: 'system',
      eventData: {
        eventId,
        originalEventType: event.eventType,
        action: 'member_event_processed',
      },
    });

    return { success: true, action: 'member_event', messageSent: false };
  }

  /**
   * Handle @ mentions - respond to direct questions/engagement.
   */
  private async handleMention(
    eventId: string,
    familyId: string,
  ): Promise<AdminHandleResult> {
    const event = await this.eventRepo.findById(familyId, eventId);
    if (!event) {
      return { success: false, action: 'mention', error: 'Event not found' };
    }

    // Load family info for context and language
    const family = await this.familyRepo.findById(familyId);
    const familyName = family?.name || 'your family';
    const language = this.getLanguageFromConfig(family?.config);

    const response = formatMentionMessage(language, familyName);

    // Get external message ID to reply to
    const externalMessageId = event.externalEventId
      ? parseInt(event.externalEventId, 10)
      : undefined;

    await this.messageSender.sendMessage(BotRole.ADMIN, {
      chatId: event.conversationId,
      text: response,
      replyToMessageId:
        externalMessageId && !isNaN(externalMessageId)
          ? externalMessageId
          : undefined,
    });

    await this.eventLog.log({
      familyId,
      eventType: 'event_processed',
      eventCategory: 'bot_action',
      actor: 'admin',
      actorType: 'system',
      eventData: {
        eventId,
        action: 'mention_responded',
        messageContent: event.contentOriginal?.slice(0, 100),
      },
    });

    return { success: true, action: 'mention', messageSent: true };
  }

  /**
   * Get stats for a family.
   */
  private async getFamilyStats(
    familyId: string,
  ): Promise<{ eventCount: number; memberCount: number }> {
    try {
      // Get family to find conversation ID
      const family = await this.familyRepo.findById(familyId);
      if (!family?.chatId) {
        return { eventCount: 0, memberCount: 0 };
      }

      // Get event count (use chatId as conversationId)
      const events = await this.eventRepo.findRecent(
        familyId,
        family.chatId,
        1000,
      );
      const eventCount = events.length;

      // Get unique members
      const members = new Set(
        events.map((e) => e.actorExternalId).filter(Boolean),
      );
      const memberCount = members.size;

      return { eventCount, memberCount };
    } catch {
      return { eventCount: 0, memberCount: 0 };
    }
  }

  /**
   * Format the status message using language-aware templates.
   */
  private formatStatus(
    family: Family,
    stats: { eventCount: number; memberCount: number },
  ): string {
    const language = this.getLanguageFromConfig(family.config);
    return formatStatusMessage(
      language,
      family.name,
      stats,
      family.createdAt ? new Date(family.createdAt) : undefined,
    );
  }

  /**
   * Extract primary language from family config.
   * Defaults to 'en' if not configured.
   */
  private getLanguageFromConfig(
    config: FamilyConfig | undefined,
  ): SupportedLanguage {
    return config?.languages?.primary ?? DEFAULT_LANGUAGE;
  }
}
