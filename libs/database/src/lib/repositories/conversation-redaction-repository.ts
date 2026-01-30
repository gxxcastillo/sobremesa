import type { DatabaseClient } from '../client';
import type { ConversationRedaction } from '@sobremesa/shared-types';
import { mapRowToCamelCase, mapRecordToSnakeCase } from '../base-repository.js';
import { EventLogRepository } from './event-log-repository.js';

/**
 * Repository for conversation redactions (non-destructive privacy control).
 * conversation_events remains immutable; redaction is tracked separately.
 * Automatically logs all redaction/unredaction actions to event_log.
 */
export class ConversationRedactionRepository {
  private client: DatabaseClient;
  private tableName = 'conversation_redactions';
  private eventLog: EventLogRepository;

  constructor(client: DatabaseClient, eventLog?: EventLogRepository) {
    this.client = client;
    this.eventLog = eventLog || new EventLogRepository(this.client);
  }

  /**
   * Redact a conversation event.
   * Creates a redaction record - the original event remains immutable.
   * Automatically logs the redaction to event_log for audit trail.
   */
  async redact(params: {
    familyId: string;
    conversationEventId: string;
    redactionReason: string;
    redactedByIdentityId?: string;
    actor?: string;
  }): Promise<ConversationRedaction> {
    // First, log the redaction action
    const eventLogEntry = await this.eventLog.log({
      familyId: params.familyId,
      eventType: 'event_redacted',
      eventCategory: 'user_action',
      actor: params.actor,
      actorType: params.redactedByIdentityId ? 'user' : 'system',
      identityId: params.redactedByIdentityId,
      conversationEventId: params.conversationEventId,
      eventData: {
        reason: params.redactionReason,
        conversationEventId: params.conversationEventId,
      },
      severity: 'info',
    });

    // Then create the redaction record
    const { data, error } = await this.client
      .from(this.tableName)
      .insert(
        mapRecordToSnakeCase({
          familyId: params.familyId,
          conversationEventId: params.conversationEventId,
          redactionReason: params.redactionReason,
          redactedByIdentityId: params.redactedByIdentityId,
          eventLogId: eventLogEntry.id,
        }),
      )
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to redact event: ${error.message}`);
    }

    return mapRowToCamelCase<ConversationRedaction>(data);
  }

  /**
   * Un-redact a conversation event (remove redaction record).
   * This is reversible - the original event was never modified.
   * Automatically logs the unredaction to event_log for audit trail.
   */
  async unredact(params: {
    familyId: string;
    conversationEventId: string;
    unredactedByIdentityId?: string;
    actor?: string;
  }): Promise<void> {
    // First, get the existing redaction record for audit data
    const existingRedaction = await this.findByConversationEventId(
      params.familyId,
      params.conversationEventId,
    );

    if (!existingRedaction) {
      throw new Error('Redaction record not found - event is not redacted');
    }

    // Log the unredaction action
    await this.eventLog.log({
      familyId: params.familyId,
      eventType: 'event_unredacted',
      eventCategory: 'user_action',
      actor: params.actor,
      actorType: params.unredactedByIdentityId ? 'user' : 'system',
      identityId: params.unredactedByIdentityId,
      conversationEventId: params.conversationEventId,
      eventData: {
        conversationEventId: params.conversationEventId,
        originalRedactionReason: existingRedaction.redactionReason,
        originalRedactedAt: existingRedaction.redactedAt,
      },
      severity: 'info',
    });

    // Then delete the redaction record
    const { error } = await this.client
      .from(this.tableName)
      .delete()
      .eq('family_id', params.familyId)
      .eq('conversation_event_id', params.conversationEventId);

    if (error) {
      throw new Error(`Failed to unredact event: ${error.message}`);
    }
  }

  /**
   * Check if a conversation event is redacted.
   */
  async isRedacted(
    familyId: string,
    conversationEventId: string,
  ): Promise<boolean> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('id')
      .eq('family_id', familyId)
      .eq('conversation_event_id', conversationEventId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to check redaction: ${error.message}`);
    }

    return !!data;
  }

  /**
   * Find all redacted events for a family.
   */
  async findRedacted(
    familyId: string,
    options?: {
      limit?: number;
      offset?: number;
    },
  ): Promise<ConversationRedaction[]> {
    let query = this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .order('redacted_at', { ascending: false });

    if (options?.limit) {
      query = query.limit(options.limit);
    }

    if (options?.offset) {
      query = query.range(
        options.offset,
        options.offset + (options.limit || 50) - 1,
      );
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to find redacted events: ${error.message}`);
    }

    return (data || []).map((row) =>
      mapRowToCamelCase<ConversationRedaction>(row),
    );
  }

  /**
   * Find redaction record by conversation event ID.
   */
  async findByConversationEventId(
    familyId: string,
    conversationEventId: string,
  ): Promise<ConversationRedaction | null> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('conversation_event_id', conversationEventId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to find redaction: ${error.message}`);
    }

    return data ? mapRowToCamelCase<ConversationRedaction>(data) : null;
  }

  /**
   * Count redacted events for a family.
   */
  async countRedacted(familyId: string): Promise<number> {
    const { count, error } = await this.client
      .from(this.tableName)
      .select('*', { count: 'exact', head: true })
      .eq('family_id', familyId);

    if (error) {
      throw new Error(`Failed to count redacted events: ${error.message}`);
    }

    return count || 0;
  }
}
