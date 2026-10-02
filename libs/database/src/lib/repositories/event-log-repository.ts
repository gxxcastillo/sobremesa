import type { DatabaseClient } from '../client';
import type {
  EventLogEntry,
  EventLogType,
  EventCategory,
  ActorType,
  Severity,
} from '@sobremesa/shared-types';
import { mapRowToCamelCase } from '../base-repository.js';

/**
 * Repository for the event log (audit trail).
 * Append-only - no updates or deletes.
 */
export class EventLogRepository {
  private client: DatabaseClient;
  private tableName = 'event_log';

  constructor(client: DatabaseClient) {
    this.client = client;
  }

  /**
   * Log an event.
   */
  async log(entry: {
    familyId: string;
    eventType: EventLogType;
    eventCategory: EventCategory;
    actor?: string;
    actorType?: ActorType;
    eventData?: Record<string, unknown>;
    conversationEventId?: string;
    sessionId?: string;
    identityId?: string;
    severity?: Severity;
  }): Promise<EventLogEntry> {
    const { data, error } = await this.client
      .from(this.tableName)
      .insert({
        family_id: entry.familyId,
        event_type: entry.eventType,
        event_category: entry.eventCategory,
        actor: entry.actor,
        actor_type: entry.actorType,
        event_data: entry.eventData,
        conversation_event_id: entry.conversationEventId,
        session_id: entry.sessionId,
        identity_id: entry.identityId,
        severity: entry.severity || 'info',
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to log event: ${error.message}`);
    }

    return mapRowToCamelCase<EventLogEntry>(data);
  }

  /**
   * Find recent events for a family.
   */
  async findRecent(
    familyId: string,
    options?: {
      limit?: number;
      eventType?: EventLogType;
      eventCategory?: EventCategory;
    },
  ): Promise<EventLogEntry[]> {
    let query = this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .order('created_at', { ascending: false });

    if (options?.eventType) {
      query = query.eq('event_type', options.eventType);
    }

    if (options?.eventCategory) {
      query = query.eq('event_category', options.eventCategory);
    }

    if (options?.limit) {
      query = query.limit(options.limit);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to find recent events: ${error.message}`);
    }

    return (data || []).map((row) => mapRowToCamelCase<EventLogEntry>(row));
  }

  /**
   * Find events by actor.
   */
  async findByActor(
    familyId: string,
    actor: string,
    limit = 50,
  ): Promise<EventLogEntry[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('actor', actor)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to find events by actor: ${error.message}`);
    }

    return (data || []).map((row) => mapRowToCamelCase<EventLogEntry>(row));
  }

  /**
   * Count events in a time window.
   */
  async countInWindow(
    familyId: string,
    eventType: EventLogType,
    windowStartAt: Date,
    filter?: { actor?: string; dataEquals?: Record<string, string> },
  ): Promise<number> {
    let query = this.client
      .from(this.tableName)
      .select('*', { count: 'exact', head: true })
      .eq('family_id', familyId)
      .eq('event_type', eventType)
      .gte('created_at', windowStartAt.toISOString());

    if (filter?.actor) {
      query = query.eq('actor', filter.actor);
    }
    for (const [key, value] of Object.entries(filter?.dataEquals ?? {})) {
      query = query.eq(`event_data->>${key}`, value);
    }

    const { count, error } = await query;

    if (error) {
      throw new Error(`Failed to count events: ${error.message}`);
    }

    return count || 0;
  }

  /**
   * Events of one type at or after `since`, newest first, optionally only
   * one severity (e.g. the error-severity `followup_evaluated` rows the
   * operator report lists).
   */
  async findInWindow(
    familyId: string,
    eventType: EventLogType,
    since: Date,
    options?: { severity?: Severity; limit?: number },
  ): Promise<EventLogEntry[]> {
    let query = this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('event_type', eventType)
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: false })
      .limit(options?.limit ?? 100);

    if (options?.severity) {
      query = query.eq('severity', options.severity);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to find events in window: ${error.message}`);
    }

    return (data || []).map((row) => mapRowToCamelCase<EventLogEntry>(row));
  }
}
