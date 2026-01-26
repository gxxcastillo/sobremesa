import { SupabaseClient } from '@supabase/supabase-js';
import type { TimelineEvent, ExtractedEvent } from '@sobremesa/shared-types';
import {
  BaseRepository,
  mapRowToCamelCase,
  mapRecordToSnakeCase,
} from '../base-repository.js';

/**
 * Repository for timeline events derived from claims.
 */
export class TimelineEventRepository extends BaseRepository<TimelineEvent> {
  constructor(client?: SupabaseClient) {
    super('events', client);
  }

  /**
   * Find an event by title.
   */
  async findByTitle(
    familyId: string,
    title: string,
  ): Promise<TimelineEvent | null> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('redacted', false)
      .ilike('title', title)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      throw new Error(`Failed to find event by title: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Find events by time range.
   */
  async findByTimeRange(
    familyId: string,
    startYear: number,
    endYear: number,
  ): Promise<TimelineEvent[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('redacted', false)
      .gte('date_year', startYear)
      .lte('date_year', endYear)
      .order('date_year', { ascending: true });

    if (error) {
      throw new Error(`Failed to find events by time range: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find events involving a specific person.
   */
  async findByPerson(
    familyId: string,
    personId: string,
  ): Promise<TimelineEvent[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('redacted', false)
      .contains('people_involved', [personId])
      .order('date_year', { ascending: true });

    if (error) {
      throw new Error(`Failed to find events by person: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find events by type.
   */
  async findByType(
    familyId: string,
    eventType: string,
  ): Promise<TimelineEvent[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('redacted', false)
      .eq('event_type', eventType)
      .order('date_year', { ascending: true });

    if (error) {
      throw new Error(`Failed to find events by type: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Create a timeline event from extracted data.
   */
  async createFromExtracted(
    familyId: string,
    extracted: ExtractedEvent,
    peopleIds: string[],
    placeId: string | undefined,
    sourceEventId: string,
    claimedBy?: string,
  ): Promise<TimelineEvent> {
    const record: Omit<TimelineEvent, 'id' | 'createdAt' | 'updatedAt'> = {
      familyId,
      title: extracted.title,
      eventType: extracted.eventType,
      dateText: extracted.dateText,
      dateYear: extracted.dateYear,
      peopleInvolved: peopleIds,
      placeId,
      sourceEventId,
      claimedBy,
      redacted: false,
    };

    return await this.insert(record);
  }

  /**
   * Find all events for a family.
   */
  async findAllActive(familyId: string): Promise<TimelineEvent[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('redacted', false)
      .order('date_year', { ascending: true });

    if (error) {
      throw new Error(`Failed to find events: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  protected mapFromDb(row: Record<string, unknown>): TimelineEvent {
    return mapRowToCamelCase<TimelineEvent>(row);
  }

  protected mapToDb(record: TimelineEvent): Record<string, unknown> {
    return mapRecordToSnakeCase(record as unknown as Record<string, unknown>);
  }
}
