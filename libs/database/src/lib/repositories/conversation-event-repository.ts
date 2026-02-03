import type { DatabaseClient } from '../client';
import type { ConversationEvent } from '@sobremesa/shared-types';
import {
  BaseRepository,
  mapRowToCamelCase,
  mapRecordToSnakeCase,
} from '../base-repository.js';

/**
 * Repository for conversation events (raw message ingestion).
 */
export class ConversationEventRepository extends BaseRepository<ConversationEvent> {
  constructor(client: DatabaseClient) {
    super(client, 'conversation_events');
  }

  /**
   * Find unprocessed events for a family.
   * Uses processing_queue for processing status and excludes redacted events.
   * Events are considered unprocessed if:
   * - They have no queue entry yet, OR
   * - They have a queue entry with status='queued'
   */
  async findUnprocessed(
    familyId: string,
    limit = 100,
  ): Promise<ConversationEvent[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select(
        `
        *,
        queue:processing_queue(status),
        redacted:conversation_redactions(id)
      `,
      )
      .eq('family_id', familyId)
      .or('queue.status.is.null,queue.status.eq.queued', {
        foreignTable: 'processing_queue',
      })
      .is('redacted.id', null)
      .order('occurred_at', { ascending: true })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to find unprocessed events: ${error.message}`);
    }

    return (data || []).map((row) => this.filterJoinedFields(row));
  }

  /**
   * Find recent events for context.
   * Excludes redacted events using LEFT JOIN.
   * Optionally includes preprocessing data from conversation_event_processing.
   */
  async findRecent(
    familyId: string,
    conversationId: string,
    limit = 20,
    includeProcessing = false,
  ): Promise<ConversationEvent[]> {
    const selectFields = includeProcessing
      ? `
        *,
        redacted:conversation_redactions(id),
        processing:conversation_event_processing(detected_language)
      `
      : `
        *,
        redacted:conversation_redactions(id)
      `;

    const { data, error } = await this.client
      .from(this.tableName)
      .select(selectFields)
      .eq('family_id', familyId)
      .eq('conversation_id', conversationId)
      .is('redacted.id', null)
      .order('occurred_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to find recent events: ${error.message}`);
    }

    if (!data) {
      return [];
    }

    return data.map((row) =>
      this.filterJoinedFields(row as unknown as Record<string, unknown>),
    );
  }

  /**
   * Find by external event ID (for deduplication).
   */
  async findByExternalId(
    familyId: string,
    source: string,
    conversationId: string,
    externalEventId: string,
  ): Promise<ConversationEvent | null> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('source', source)
      .eq('conversation_id', conversationId)
      .eq('external_event_id', externalEventId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      throw new Error(`Failed to find event by external id: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Find unprocessed events of a specific type for a conversation.
   * Useful for consolidating events (e.g., multiple join events).
   * Uses processing_queue for processing status and excludes redacted events.
   */
  async findUnprocessedByType(
    familyId: string,
    conversationId: string,
    eventType: string,
  ): Promise<ConversationEvent[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select(
        `
        *,
        queue:processing_queue(status),
        redacted:conversation_redactions(id)
      `,
      )
      .eq('family_id', familyId)
      .eq('conversation_id', conversationId)
      .eq('event_type', eventType)
      .or('queue.status.is.null,queue.status.eq.queued', {
        foreignTable: 'processing_queue',
      })
      .is('redacted.id', null)
      .order('occurred_at', { ascending: true });

    if (error) {
      throw new Error(
        `Failed to find unprocessed events by type: ${error.message}`,
      );
    }

    return (data || []).map((row) => this.filterJoinedFields(row));
  }

  /**
   * Filter out joined fields that are not part of ConversationEvent schema.
   * These fields (queue, redacted, processing) are used for filtering but should not be returned.
   */
  private filterJoinedFields(row: Record<string, unknown>): ConversationEvent {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { queue, redacted, processing, ...eventData } = row;
    return mapRowToCamelCase<ConversationEvent>(eventData);
  }

  protected mapFromDb(row: Record<string, unknown>): ConversationEvent {
    return mapRowToCamelCase<ConversationEvent>(row);
  }

  protected mapToDb(record: ConversationEvent): Record<string, unknown> {
    return mapRecordToSnakeCase(record as unknown as Record<string, unknown>);
  }
}
