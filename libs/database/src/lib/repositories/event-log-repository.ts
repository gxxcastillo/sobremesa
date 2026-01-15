import { SupabaseClient } from '@supabase/supabase-js';
import type {
  EventLogEntry,
  EventLogType,
  EventCategory,
  ActorType,
  Severity,
} from '@sobremesa/shared-types';
import { getServiceClient } from '../client.js';
import { mapRowToCamelCase } from '../base-repository.js';

/**
 * Repository for the event log (audit trail).
 * Append-only - no updates or deletes.
 */
export class EventLogRepository {
  private client: SupabaseClient;
  private tableName = 'event_log';

  constructor(client?: SupabaseClient) {
    this.client = client || getServiceClient();
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
    sourceEventId?: string;
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
        source_event_id: entry.sourceEventId,
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
  ): Promise<number> {
    const { count, error } = await this.client
      .from(this.tableName)
      .select('*', { count: 'exact', head: true })
      .eq('family_id', familyId)
      .eq('event_type', eventType)
      .gte('created_at', windowStartAt.toISOString());

    if (error) {
      throw new Error(`Failed to count events: ${error.message}`);
    }

    return count || 0;
  }
}
