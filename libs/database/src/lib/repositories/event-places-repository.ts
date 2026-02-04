import type { DatabaseClient } from '../client';
import type { EventPlace } from '@sobremesa/shared-types';
import {
  mapRowToCamelCase,
  mapRecordToSnakeCase,
  dedupeByKeys,
} from '../base-repository.js';

/**
 * Repository for event-place relationships (many-to-many join table).
 */
export class EventPlacesRepository {
  protected client: DatabaseClient;
  protected tableName = 'event_places';

  constructor(client: DatabaseClient) {
    this.client = client;
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
      .upsert(dbRecord, { onConflict: 'family_id,event_id,place_id' })
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

    const dbRecords = dedupeByKeys(links.map(mapRecordToSnakeCase), [
      'family_id',
      'event_id',
      'place_id',
    ]);

    const { data, error } = await this.client
      .from(this.tableName)
      .upsert(dbRecords, { onConflict: 'family_id,event_id,place_id' })
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
