import { SupabaseClient } from '@supabase/supabase-js';
import type { ConversationEvent } from '@sobremesa/shared-types';
import { BaseRepository, mapRowToCamelCase, mapRecordToSnakeCase } from '../base-repository.js';

/**
 * Repository for conversation events (raw message ingestion).
 */
export class ConversationEventRepository extends BaseRepository<ConversationEvent> {
  constructor(client?: SupabaseClient) {
    super('conversation_events', client);
  }

  /**
   * Find unprocessed events for a family.
   */
  async findUnprocessed(
    familyId: string,
    limit = 100
  ): Promise<ConversationEvent[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('processed', false)
      .eq('redacted', false)
      .order('occurred_at', { ascending: true })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to find unprocessed events: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find recent events for context.
   */
  async findRecent(
    familyId: string,
    conversationId: string,
    limit = 20
  ): Promise<ConversationEvent[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('conversation_id', conversationId)
      .eq('redacted', false)
      .order('occurred_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to find recent events: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Mark an event as processed.
   */
  async markProcessed(
    familyId: string,
    id: string,
    error?: string
  ): Promise<void> {
    const updates: Record<string, unknown> = {
      processed: true,
      processed_at: new Date().toISOString(),
    };

    if (error) {
      updates['processing_error'] = error;
    }

    const { error: dbError } = await this.client
      .from(this.tableName)
      .update(updates)
      .eq('family_id', familyId)
      .eq('id', id);

    if (dbError) {
      throw new Error(`Failed to mark event as processed: ${dbError.message}`);
    }
  }

  /**
   * Find by external event ID (for deduplication).
   */
  async findByExternalId(
    familyId: string,
    source: string,
    conversationId: string,
    externalEventId: string
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

  protected mapFromDb(row: Record<string, unknown>): ConversationEvent {
    return mapRowToCamelCase<ConversationEvent>(row);
  }

  protected mapToDb(record: ConversationEvent): Record<string, unknown> {
    return mapRecordToSnakeCase(record as unknown as Record<string, unknown>);
  }
}
