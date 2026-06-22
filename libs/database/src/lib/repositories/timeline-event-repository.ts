import type { DatabaseClient } from '../client';
import type { TimelineEvent, ExtractedEvent } from '@sobremesa/shared-types';
import {
  BaseRepository,
  mapRowToCamelCase,
  mapRecordToSnakeCase,
} from '../base-repository.js';
import { wordOverlapSimilarity } from '../text-similarity.js';

/**
 * Event-dedup scoring constants. Entity resolution favors precision over recall
 * (spec overview §1.7 invariant 6): a false merge collapses two distinct events
 * into one and destroys a memory, so matches must be structurally anchored.
 */
/** Two dated events more than this many years apart are never the same event. */
const MAX_YEAR_GAP = 2;
/** Score boost when an existing candidate shares a person with the new event. */
const PERSON_OVERLAP_BOOST = 0.1;
/** Score boost when both events are dated and within MAX_YEAR_GAP. */
const DATE_PROXIMITY_BOOST = 0.15;
/** Minimum score (after boosts) to treat a candidate as the same event. */
const MATCH_THRESHOLD = 0.6;

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
   * Uses word-overlap scoring in application code instead of SQL ilike.
   */
  async findSimilar(
    familyId: string,
    title: string,
    personIds: string[],
    dateYear?: number,
  ): Promise<TimelineEvent | null> {
    let candidates: TimelineEvent[];

    if (personIds.length > 0) {
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
        // No events for these people — fall through to all active
        candidates = await this.findAllActive(familyId);
      } else {
        const candidateEventIds = [
          ...new Set(eventPeopleData.map((row) => row.event_id)),
        ];

        const { data, error } = await this.client
          .from(this.tableName)
          .select('*')
          .eq('family_id', familyId)
          .eq('redacted', false)
          .in('id', candidateEventIds);

        if (error) {
          throw new Error(`Failed to fetch candidate events: ${error.message}`);
        }

        candidates = (data || []).map((row) => this.mapFromDb(row));
      }
    } else {
      candidates = await this.findAllActive(familyId);
    }

    if (candidates.length === 0) return null;

    // Batch-fetch person links for all candidates at once (avoids N+1 queries)
    const personOverlapSet = new Set<string>();
    if (personIds.length > 0) {
      const candidateIds = candidates.map((c) => c.id);
      const { data: epBatch } = await this.client
        .from('event_people')
        .select('event_id, person_id')
        .eq('family_id', familyId)
        .in('event_id', candidateIds)
        .in('person_id', personIds);

      for (const row of epBatch || []) {
        personOverlapSet.add(row.event_id);
      }
    }

    // Score candidates using word-overlap + contextual boosts
    let bestMatch: TimelineEvent | null = null;
    let bestScore = 0;

    for (const candidate of candidates) {
      const hasPersonOverlap = personOverlapSet.has(candidate.id);

      const bothDated = dateYear !== undefined && candidate.dateYear != null;
      const yearDiff = bothDated
        ? Math.abs(dateYear - (candidate.dateYear as number))
        : undefined;

      // Hard date filter (#1): two dated events more than MAX_YEAR_GAP apart are
      // different events regardless of how similar their titles are. Excluding the
      // candidate outright restores the old ±2yr SQL gate that became a soft penalty.
      if (yearDiff !== undefined && yearDiff > MAX_YEAR_GAP) {
        continue;
      }

      const dateCorroborates =
        yearDiff !== undefined && yearDiff <= MAX_YEAR_GAP;

      // Structural anchor required (#2): title similarity alone is never enough to
      // merge — that let generic-titled, person-less events ('lunch', 'the trip')
      // collapse into any title-overlapping event. Require either a shared person
      // or corroborating dates before a title score can count.
      if (!hasPersonOverlap && !dateCorroborates) {
        continue;
      }

      let score = wordOverlapSimilarity(title, candidate.title);
      if (hasPersonOverlap) score += PERSON_OVERLAP_BOOST;
      if (dateCorroborates) score += DATE_PROXIMITY_BOOST;

      if (score > bestScore) {
        bestScore = score;
        bestMatch = candidate;
      }
    }

    return bestScore >= MATCH_THRESHOLD ? bestMatch : null;
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
      // Enrich existing event with any new non-null fields
      const enrichments: Partial<TimelineEvent> = {};
      if (!existing.placeId && placeId) enrichments.placeId = placeId;
      if (!existing.dateText && extracted.dateText)
        enrichments.dateText = extracted.dateText;
      if (!existing.dateYear && extracted.dateYear)
        enrichments.dateYear = extracted.dateYear;
      if (!existing.eventType && extracted.eventType)
        enrichments.eventType = extracted.eventType;

      if (Object.keys(enrichments).length > 0) {
        const enriched = await this.update(familyId, existing.id, enrichments);
        return { event: enriched, created: false };
      }

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
