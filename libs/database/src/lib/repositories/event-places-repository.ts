import { SupabaseClient } from '@supabase/supabase-js';
import type { EventPlace } from '@sobremesa/shared-types';
import { getServiceClient } from '../client.js';
import { mapRowToCamelCase, mapRecordToSnakeCase } from '../base-repository.js';

/**
 * Repository for event-place relationships (many-to-many join table).
 */
export class EventPlacesRepository {
  protected client: SupabaseClient;
  protected tableName = 'event_places';

  constructor(client?: SupabaseClient) {
    this.client = client || getServiceClient();
  }

  async findByEvent(familyId: string, eventId: string): Promise<EventPlace[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('event_id', eventId)
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error(`Failed to find event places: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  async findByPlace(familyId: string, placeId: string): Promise<EventPlace[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('place_id', placeId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find place events: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  async create(link: Omit<EventPlace, 'createdAt'>): Promise<EventPlace> {
    const dbRecord = mapRecordToSnakeCase(link);

    const { data, error } = await this.client
      .from(this.tableName)
      .insert(dbRecord)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create event-place link: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  async createMany(
    links: Array<Omit<EventPlace, 'createdAt'>>,
  ): Promise<EventPlace[]> {
    if (links.length === 0) return [];

    const dbRecords = links.map(mapRecordToSnakeCase);

    const { data, error } = await this.client
      .from(this.tableName)
      .insert(dbRecords)
      .select();

    if (error) {
      throw new Error(`Failed to create event-place links: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  async delete(
    familyId: string,
    eventId: string,
    placeId: string,
  ): Promise<void> {
    const { error } = await this.client
      .from(this.tableName)
      .delete()
      .eq('family_id', familyId)
      .eq('event_id', eventId)
      .eq('place_id', placeId);

    if (error) {
      throw new Error(`Failed to delete event-place link: ${error.message}`);
    }
  }

  async deleteByEvent(familyId: string, eventId: string): Promise<void> {
    const { error } = await this.client
      .from(this.tableName)
      .delete()
      .eq('family_id', familyId)
      .eq('event_id', eventId);

    if (error) {
      throw new Error(`Failed to delete places for event: ${error.message}`);
    }
  }

  private mapFromDb(row: any): EventPlace {
    return mapRowToCamelCase(row) as EventPlace;
  }
}
