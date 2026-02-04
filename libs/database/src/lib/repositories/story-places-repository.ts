import type { DatabaseClient } from '../client';
import type { StoryPlace } from '@sobremesa/shared-types';
import {
  mapRowToCamelCase,
  mapRecordToSnakeCase,
  dedupeByKeys,
} from '../base-repository.js';

/**
 * Repository for story-place relationships (many-to-many join table).
 */
export class StoryPlacesRepository {
  protected client: DatabaseClient;
  protected tableName = 'story_places';

  constructor(client: DatabaseClient) {
    this.client = client;
  }

  async findByStory(familyId: string, storyId: string): Promise<StoryPlace[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('story_id', storyId)
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error(`Failed to find story places: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  async findByPlace(familyId: string, placeId: string): Promise<StoryPlace[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('place_id', placeId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find place stories: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  async create(link: Omit<StoryPlace, 'createdAt'>): Promise<StoryPlace> {
    const dbRecord = mapRecordToSnakeCase(link);

    const { data, error } = await this.client
      .from(this.tableName)
      .upsert(dbRecord, { onConflict: 'family_id,story_id,place_id' })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create story-place link: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  async createMany(
    links: Array<Omit<StoryPlace, 'createdAt'>>,
  ): Promise<StoryPlace[]> {
    if (links.length === 0) return [];

    const dbRecords = dedupeByKeys(links.map(mapRecordToSnakeCase), [
      'family_id',
      'story_id',
      'place_id',
    ]);

    const { data, error } = await this.client
      .from(this.tableName)
      .upsert(dbRecords, { onConflict: 'family_id,story_id,place_id' })
      .select();

    if (error) {
      throw new Error(`Failed to create story-place links: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  async delete(
    familyId: string,
    storyId: string,
    placeId: string,
  ): Promise<void> {
    const { error } = await this.client
      .from(this.tableName)
      .delete()
      .eq('family_id', familyId)
      .eq('story_id', storyId)
      .eq('place_id', placeId);

    if (error) {
      throw new Error(`Failed to delete story-place link: ${error.message}`);
    }
  }

  async deleteByStory(familyId: string, storyId: string): Promise<void> {
    const { error } = await this.client
      .from(this.tableName)
      .delete()
      .eq('family_id', familyId)
      .eq('story_id', storyId);

    if (error) {
      throw new Error(`Failed to delete places for story: ${error.message}`);
    }
  }

  private mapFromDb(row: any): StoryPlace {
    return mapRowToCamelCase(row) as StoryPlace;
  }
}
