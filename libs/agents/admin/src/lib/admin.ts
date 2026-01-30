import {
  ConversationEventRepository,
  FamilyRepository,
  EventLogRepository,
  ProcessingQueueRepository,
  type DatabaseClient,
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
  Priorities,
} from '@sobremesa/shared-types';
import {
  formatHelpMessage,
  formatMemberJoinPluralMessage,
  formatMemberLeaveMessage,
  formatMentionMessage,
  formatStatusMessage,
} from './messages';

export type { MessageSender };

/**
 * Options for AdminAgent.
 */
export interface AdminAgentOptions {
  /** Database client (required if repositories not provided) */
  dbClient?: DatabaseClient;
  /** Message sender (typically BotManager) */
  messageSender: MessageSender;
  /** Conversation event repository */
  eventRepo?: ConversationEventRepository;
  /** Family repository */
  familyRepo?: FamilyRepository;
  /** Event log repository */
  eventLog?: EventLogRepository;
  /** Processing queue repository */
  queueRepo?: ProcessingQueueRepository;
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
  private eventRepo!: ConversationEventRepository;
  private familyRepo!: FamilyRepository;
  private eventLog!: EventLogRepository;
  private queueRepo!: ProcessingQueueRepository;
  private logger: pino.Logger;

  constructor(options: AdminAgentOptions) {
    const { dbClient } = options;

    if (options.eventRepo) {
      this.eventRepo = options.eventRepo;
    } else if (dbClient) {
      this.eventRepo = new ConversationEventRepository(dbClient);
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

    if (options.queueRepo) {
      this.queueRepo = options.queueRepo;
    } else if (dbClient) {
      this.queueRepo = new ProcessingQueueRepository(dbClient);
    }

    if (
      !this.eventRepo ||
      !this.familyRepo ||
      !this.eventLog ||
      !this.queueRepo
    ) {
      throw new Error(
        'AdminAgent requires either dbClient or all repository instances',
      );
    }

    this.messageSender = options.messageSender;
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

    // Send reply (user-triggered, high priority)
    await this.messageSender.sendMessage(
      'admin',
      {
        chatId: event.conversationId,
        text: statusMessage,
        replyToMessageId:
          externalMessageId && !isNaN(externalMessageId)
            ? externalMessageId
            : undefined,
      },
      { priority: Priorities.USER_RESPONSE },
    );

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

    // User-triggered, high priority
    await this.messageSender.sendMessage(
      'admin',
      {
        chatId: event.conversationId,
        text: helpMessage,
      },
      { priority: Priorities.USER_RESPONSE },
    );

    return { success: true, action: 'dm', messageSent: true };
  }

  /**
   * Handle member events - notify when members join or leave.
   * For join events, consolidates multiple joins into a single message.
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

    // Load family info for context and language
    const family = await this.familyRepo.findById(familyId);
    const familyName = family?.name || 'the family';
    const language = this.getLanguageFromConfig(family?.config);

    // Handle join events with consolidation
    if (event.eventType === 'join') {
      return this.handleConsolidatedJoin(
        familyId,
        event.conversationId,
        familyName,
        language,
      );
    }

    // Handle leave events individually
    if (event.eventType === 'leave') {
      const memberName =
        event.actorDisplayName || event.actorUsername || 'friend';
      const notificationMessage = formatMemberLeaveMessage(
        language,
        memberName,
      );

      await this.messageSender.sendMessage(
        'admin',
        {
          chatId: event.conversationId,
          text: notificationMessage,
        },
        { priority: Priorities.MEMBER_NOTIFICATION },
      );

      this.logger.info(
        { eventId, familyId, eventType: 'leave', memberName },
        'Leave notification sent',
      );

      await this.eventLog.log({
        familyId,
        eventType: 'event_processed',
        eventCategory: 'bot_action',
        actor: 'admin',
        actorType: 'system',
        eventData: {
          eventId,
          originalEventType: 'leave',
          action: 'member_notification_sent',
          memberName,
        },
      });

      return { success: true, action: 'member_event', messageSent: true };
    }

    // Unknown member event type
    this.logger.warn(
      { eventId, familyId, eventType: event.eventType },
      'Unknown member event type',
    );
    return { success: true, action: 'member_event', messageSent: false };
  }

  /**
   * Handle consolidated join events - finds all pending join events
   * for the conversation and sends a single welcome message.
   */
  private async handleConsolidatedJoin(
    familyId: string,
    conversationId: string,
    familyName: string,
    language: SupportedLanguage,
  ): Promise<AdminHandleResult> {
    // Find all unprocessed join events for this conversation
    const joinEvents = await this.eventRepo.findUnprocessedByType(
      familyId,
      conversationId,
      'join',
    );

    if (joinEvents.length === 0) {
      // Event was already processed (possibly by another worker)
      return { success: true, action: 'member_event', messageSent: false };
    }

    // Extract member names (deduplicate by external ID)
    const seenIds = new Set<string>();
    const memberNames: string[] = [];
    for (const evt of joinEvents) {
      const actorId = evt.actorExternalId;
      if (actorId && !seenIds.has(actorId)) {
        seenIds.add(actorId);
        memberNames.push(evt.actorDisplayName || evt.actorUsername || 'friend');
      }
    }

    // Format the consolidated message
    const notificationMessage = formatMemberJoinPluralMessage(
      language,
      memberNames,
      familyName,
    );

    // Send the notification
    await this.messageSender.sendMessage(
      'admin',
      {
        chatId: conversationId,
        text: notificationMessage,
      },
      { priority: Priorities.MEMBER_NOTIFICATION },
    );

    // Mark queue items as done
    const eventIds = joinEvents.map((e) => e.id);
    const queueItems = await this.queueRepo.findPendingByEventIds(
      familyId,
      eventIds,
    );
    if (queueItems.length > 0) {
      await this.queueRepo.completeMany(
        familyId,
        queueItems.map((q) => q.id),
      );
    }

    this.logger.info(
      {
        familyId,
        conversationId,
        memberCount: memberNames.length,
        memberNames,
      },
      'Consolidated join notification sent',
    );

    await this.eventLog.log({
      familyId,
      eventType: 'event_processed',
      eventCategory: 'bot_action',
      actor: 'admin',
      actorType: 'system',
      eventData: {
        eventIds,
        originalEventType: 'join',
        action: 'consolidated_join_notification_sent',
        memberCount: memberNames.length,
        memberNames,
      },
    });

    return { success: true, action: 'member_event', messageSent: true };
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

    // User-triggered, high priority
    await this.messageSender.sendMessage(
      'admin',
      {
        chatId: event.conversationId,
        text: response,
        replyToMessageId:
          externalMessageId && !isNaN(externalMessageId)
            ? externalMessageId
            : undefined,
      },
      { priority: Priorities.USER_RESPONSE },
    );

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
