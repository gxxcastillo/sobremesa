import type { DatabaseClient } from '../client';
import type { EventPerson } from '@sobremesa/shared-types';
import { mapRowToCamelCase, mapRecordToSnakeCase } from '../base-repository.js';

/**
 * Repository for event-person relationships (many-to-many join table).
 */
export class EventPeopleRepository {
  protected client: DatabaseClient;
  protected tableName = 'event_people';

  constructor(client: DatabaseClient) {
    this.client = client;
  }

  async findByEvent(familyId: string, eventId: string): Promise<EventPerson[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('event_id', eventId)
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error(`Failed to find event people: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  async findByPerson(
    familyId: string,
    personId: string,
  ): Promise<EventPerson[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('person_id', personId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find person events: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  async create(link: Omit<EventPerson, 'createdAt'>): Promise<EventPerson> {
    const dbRecord = mapRecordToSnakeCase(link);

    const { data, error } = await this.client
      .from(this.tableName)
      .insert(dbRecord)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create event-person link: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  async createMany(
    links: Array<Omit<EventPerson, 'createdAt'>>,
  ): Promise<EventPerson[]> {
    if (links.length === 0) return [];

    const dbRecords = links.map(mapRecordToSnakeCase);

    const { data, error } = await this.client
      .from(this.tableName)
      .insert(dbRecords)
      .select();

    if (error) {
      throw new Error(`Failed to create event-person links: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  async delete(
    familyId: string,
    eventId: string,
    personId: string,
  ): Promise<void> {
    const { error } = await this.client
      .from(this.tableName)
      .delete()
      .eq('family_id', familyId)
      .eq('event_id', eventId)
      .eq('person_id', personId);

    if (error) {
      throw new Error(`Failed to delete event-person link: ${error.message}`);
    }
  }

  async deleteByEvent(familyId: string, eventId: string): Promise<void> {
    const { error } = await this.client
      .from(this.tableName)
      .delete()
      .eq('family_id', familyId)
      .eq('event_id', eventId);

    if (error) {
      throw new Error(`Failed to delete people for event: ${error.message}`);
    }
  }

  private mapFromDb(row: any): EventPerson {
    return mapRowToCamelCase(row) as EventPerson;
  }
}
