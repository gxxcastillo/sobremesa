import type { DatabaseClient } from '../client';
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
  constructor(client: DatabaseClient) {
    super(client, 'events');
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
   * Uses the event_people join table.
   */
  async findByPerson(
    familyId: string,
    personId: string,
  ): Promise<TimelineEvent[]> {
    // Query via event_people join table
    const { data, error } = await this.client
      .from('event_people')
      .select('events!inner(*)')
      .eq('family_id', familyId)
      .eq('person_id', personId)
      .eq('events.redacted', false)
      .order('events.date_year', { ascending: true });

    if (error) {
      throw new Error(`Failed to find events by person: ${error.message}`);
    }

    return (data || []).map((row: any) => this.mapFromDb(row.events));
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
   * Find a similar event by title, people involved, and optional date.
   * Used for deduplication - matches if title/date match and at least one person overlaps.
   */
  async findSimilar(
    familyId: string,
    title: string,
    personIds: string[],
    dateYear?: number,
  ): Promise<TimelineEvent | null> {
    if (personIds.length === 0) {
      // No people to match - can't deduplicate without people
      return null;
    }

    // Find events involving ANY of the specified people
    const { data: eventPeopleData, error: epError } = await this.client
      .from('event_people')
      .select('event_id')
      .eq('family_id', familyId)
      .in('person_id', personIds);

    if (epError) {
      throw new Error(`Failed to query event_people: ${epError.message}`);
    }

    if (!eventPeopleData || eventPeopleData.length === 0) {
      return null;
    }

    // Get unique event IDs (any event with at least one person match)
    const candidateEventIds = [
      ...new Set(eventPeopleData.map((row) => row.event_id)),
    ];

    // Find events with similar title among the candidates
    let query = this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('redacted', false)
      .in('id', candidateEventIds)
      .ilike('title', `%${title}%`);

    // If date provided, allow ±2 year tolerance
    if (dateYear !== undefined) {
      query = query
        .gte('date_year', dateYear - 2)
        .lte('date_year', dateYear + 2);
    }

    const { data, error } = await query.limit(1).maybeSingle();

    if (error) {
      throw new Error(`Failed to find similar event: ${error.message}`);
    }

    return data ? this.mapFromDb(data) : null;
  }

  /**
   * Find or create an event, with deduplication based on title + people + date.
   */
  async findOrCreate(
    familyId: string,
    extracted: ExtractedEvent,
    personIds: string[],
    placeId: string | undefined,
    conversationEventId: string,
    claimedBy?: string,
    extractionVersion?: string,
  ): Promise<{ event: TimelineEvent; created: boolean }> {
    // Check for existing similar event
    const existing = await this.findSimilar(
      familyId,
      extracted.title,
      personIds,
      extracted.dateYear,
    );

    if (existing) {
      return { event: existing, created: false };
    }

    // Create new event
    const event = await this.createFromExtracted(
      familyId,
      extracted,
      placeId,
      conversationEventId,
      claimedBy,
      extractionVersion,
    );

    return { event, created: true };
  }

  /**
   * Create a timeline event from extracted data.
   */
  async createFromExtracted(
    familyId: string,
    extracted: ExtractedEvent,
    placeId: string | undefined,
    conversationEventId: string,
    claimedBy?: string,
    extractionVersion?: string,
  ): Promise<TimelineEvent> {
    // Note: People associations removed - use EventPeopleRepository to link people
    const record: Omit<TimelineEvent, 'id' | 'createdAt' | 'updatedAt'> = {
      familyId,
      title: extracted.title,
      eventType: extracted.eventType,
      dateText: extracted.dateText,
      dateYear: extracted.dateYear,
      placeId,
      conversationEventId,
      claimedBy,
      redacted: false,
      extractionVersion,
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
