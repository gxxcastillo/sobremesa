import type { DatabaseClient } from '../client';
import type { StoryEvent } from '@sobremesa/shared-types';
import { mapRowToCamelCase, mapRecordToSnakeCase } from '../base-repository.js';

/**
 * Repository for story-event relationships (many-to-many join table).
 */
export class StoryEventsRepository {
  protected client: DatabaseClient;
  protected tableName = 'story_events';

  constructor(client: DatabaseClient) {
    this.client = client;
  }

  async findByStory(familyId: string, storyId: string): Promise<StoryEvent[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('story_id', storyId)
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error(`Failed to find story events: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  async findByEvent(familyId: string, eventId: string): Promise<StoryEvent[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('event_id', eventId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find event stories: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  async create(link: Omit<StoryEvent, 'createdAt'>): Promise<StoryEvent> {
    const dbRecord = mapRecordToSnakeCase(link);

    const { data, error } = await this.client
      .from(this.tableName)
      .insert(dbRecord)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create story-event link: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  async createMany(
    links: Array<Omit<StoryEvent, 'createdAt'>>,
  ): Promise<StoryEvent[]> {
    if (links.length === 0) return [];

    const dbRecords = links.map(mapRecordToSnakeCase);

    const { data, error } = await this.client
      .from(this.tableName)
      .insert(dbRecords)
      .select();

    if (error) {
      throw new Error(`Failed to create story-event links: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  async delete(
    familyId: string,
    storyId: string,
    eventId: string,
  ): Promise<void> {
    const { error } = await this.client
      .from(this.tableName)
      .delete()
      .eq('family_id', familyId)
      .eq('story_id', storyId)
      .eq('event_id', eventId);

    if (error) {
      throw new Error(`Failed to delete story-event link: ${error.message}`);
    }
  }

  async deleteByStory(familyId: string, storyId: string): Promise<void> {
    const { error } = await this.client
      .from(this.tableName)
      .delete()
      .eq('family_id', familyId)
      .eq('story_id', storyId);

    if (error) {
      throw new Error(`Failed to delete events for story: ${error.message}`);
    }
  }

  private mapFromDb(row: any): StoryEvent {
    return mapRowToCamelCase(row) as StoryEvent;
  }
}
