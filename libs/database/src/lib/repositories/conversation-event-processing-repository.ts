import { SupabaseClient } from '@supabase/supabase-js';
import type {
  ConversationEventProcessing,
  ProcessingMetadata,
} from '@sobremesa/shared-types';
import { mapRowToCamelCase, mapRecordToSnakeCase } from '../base-repository.js';

/**
 * Repository for conversation event preprocessing artifacts.
 * This table is mutable and can be updated/deleted for reprocessing.
 */
export class ConversationEventProcessingRepository {
  protected tableName = 'conversation_event_processing';
  protected client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  /**
   * Find processing data for a specific event.
   */
  async findByEventId(
    familyId: string,
    eventId: string,
  ): Promise<ConversationEventProcessing | null> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('conversation_event_id', eventId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      throw new Error(`Failed to find event processing data: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Upsert processing data for an event.
   * Creates or updates the processing record.
   */
  async upsert(
    processing: Omit<ConversationEventProcessing, 'processedAt'>,
  ): Promise<ConversationEventProcessing> {
    const dbRecord = this.mapToDb({
      ...processing,
      processedAt: new Date(),
    } as ConversationEventProcessing);

    const { data, error } = await this.client
      .from(this.tableName)
      .upsert(dbRecord, {
        onConflict: 'conversation_event_id',
      })
      .select()
      .single();

    if (error) {
      throw new Error(
        `Failed to upsert conversation_event_processing: ${error.message}`,
      );
    }

    return this.mapFromDb(data);
  }

  /**
   * Delete processing data for an event (for reprocessing).
   */
  async deleteByEventId(familyId: string, eventId: string): Promise<void> {
    const { error } = await this.client
      .from(this.tableName)
      .delete()
      .eq('family_id', familyId)
      .eq('conversation_event_id', eventId);

    if (error) {
      throw new Error(
        `Failed to delete event processing data: ${error.message}`,
      );
    }
  }

  /**
   * Update processing metadata for an event, merging with existing metadata.
   * Creates a new processing record if one doesn't exist.
   */
  async updateMetadata(
    eventId: string,
    familyId: string,
    metadata: Partial<ProcessingMetadata>,
    processedBy?: string,
  ): Promise<ConversationEventProcessing> {
    // First check if record exists
    const existing = await this.findByEventId(familyId, eventId);

    const mergedMetadata: ProcessingMetadata = {
      ...(existing?.processingMetadata || {}),
      ...metadata,
    };

    return this.upsert({
      conversationEventId: eventId,
      familyId,
      ...(existing?.detectedLanguage && {
        detectedLanguage: existing.detectedLanguage,
      }),
      ...(existing?.imageReferences && {
        imageReferences: existing.imageReferences,
      }),
      processingMetadata: mergedMetadata,
      processedBy: processedBy || existing?.processedBy || 'unknown',
    });
  }

  protected mapFromDb(
    row: Record<string, unknown>,
  ): ConversationEventProcessing {
    return mapRowToCamelCase<ConversationEventProcessing>(row);
  }

  protected mapToDb(
    record: ConversationEventProcessing,
  ): Record<string, unknown> {
    return mapRecordToSnakeCase(record as unknown as Record<string, unknown>);
  }
}
