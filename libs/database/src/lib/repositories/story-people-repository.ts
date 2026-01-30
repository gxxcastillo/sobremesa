import type { DatabaseClient } from '../client';
import type { StoryPerson } from '@sobremesa/shared-types';
import { mapRowToCamelCase, mapRecordToSnakeCase } from '../base-repository.js';

/**
 * Repository for story-person relationships (many-to-many join table).
 */
export class StoryPeopleRepository {
  protected client: DatabaseClient;
  protected tableName = 'story_people';

  constructor(client: DatabaseClient) {
    this.client = client;
  }

  /**
   * Find people for a story.
   */
  async findByStory(familyId: string, storyId: string): Promise<StoryPerson[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('story_id', storyId)
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error(`Failed to find story people: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find stories for a person.
   */
  async findByPerson(
    familyId: string,
    personId: string,
  ): Promise<StoryPerson[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('person_id', personId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find person stories: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Link a person to a story.
   */
  async create(link: Omit<StoryPerson, 'createdAt'>): Promise<StoryPerson> {
    const dbRecord = mapRecordToSnakeCase(link);

    const { data, error } = await this.client
      .from(this.tableName)
      .insert(dbRecord)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create story-person link: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Link multiple people to a story in bulk.
   */
  async createMany(
    links: Array<Omit<StoryPerson, 'createdAt'>>,
  ): Promise<StoryPerson[]> {
    if (links.length === 0) return [];

    const dbRecords = links.map(mapRecordToSnakeCase);

    const { data, error } = await this.client
      .from(this.tableName)
      .insert(dbRecords)
      .select();

    if (error) {
      throw new Error(`Failed to create story-person links: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Remove a person from a story.
   */
  async delete(
    familyId: string,
    storyId: string,
    personId: string,
  ): Promise<void> {
    const { error } = await this.client
      .from(this.tableName)
      .delete()
      .eq('family_id', familyId)
      .eq('story_id', storyId)
      .eq('person_id', personId);

    if (error) {
      throw new Error(`Failed to delete story-person link: ${error.message}`);
    }
  }

  /**
   * Remove all people from a story.
   */
  async deleteByStory(familyId: string, storyId: string): Promise<void> {
    const { error } = await this.client
      .from(this.tableName)
      .delete()
      .eq('family_id', familyId)
      .eq('story_id', storyId);

    if (error) {
      throw new Error(`Failed to delete people for story: ${error.message}`);
    }
  }

  /**
   * Map database row to domain model.
   */
  private mapFromDb(row: any): StoryPerson {
    return mapRowToCamelCase(row) as StoryPerson;
  }
}
