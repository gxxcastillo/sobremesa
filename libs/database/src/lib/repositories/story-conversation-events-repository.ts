import type { DatabaseClient } from '../client';
import type { StoryConversationEvent } from '@sobremesa/shared-types';
import {
  mapRowToCamelCase,
  mapRecordToSnakeCase,
  dedupeByKeys,
} from '../base-repository.js';

/**
 * Repository for story-conversation_event relationships (provenance tracking).
 */
export class StoryConversationEventsRepository {
  protected client: DatabaseClient;
  protected tableName = 'story_conversation_events';

  constructor(client: DatabaseClient) {
    this.client = client;
  }

  /**
   * Find conversation events for a story.
   */
  async findByStory(
    familyId: string,
    storyId: string,
  ): Promise<StoryConversationEvent[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('story_id', storyId)
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error(
        `Failed to find story conversation events: ${error.message}`,
      );
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find stories that used a specific conversation event as source.
   */
  async findByConversationEvent(
    familyId: string,
    conversationEventId: string,
  ): Promise<StoryConversationEvent[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('conversation_event_id', conversationEventId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(
        `Failed to find stories by conversation event: ${error.message}`,
      );
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Link a conversation event to a story.
   */
  async create(
    link: Omit<StoryConversationEvent, 'createdAt'>,
  ): Promise<StoryConversationEvent> {
    const dbRecord = mapRecordToSnakeCase(link);

    const { data, error } = await this.client
      .from(this.tableName)
      .upsert(dbRecord, {
        onConflict: 'family_id,story_id,conversation_event_id',
      })
      .select()
      .single();

    if (error) {
      throw new Error(
        `Failed to create story conversation event link: ${error.message}`,
      );
    }

    return this.mapFromDb(data);
  }

  /**
   * Link multiple conversation events to a story.
   */
  async createMany(
    links: Array<Omit<StoryConversationEvent, 'createdAt'>>,
  ): Promise<StoryConversationEvent[]> {
    if (links.length === 0) return [];

    const dbRecords = dedupeByKeys(links.map(mapRecordToSnakeCase), [
      'family_id',
      'story_id',
      'conversation_event_id',
    ]);

    const { data, error } = await this.client
      .from(this.tableName)
      .upsert(dbRecords, {
        onConflict: 'family_id,story_id,conversation_event_id',
      })
      .select();

    if (error) {
      throw new Error(
        `Failed to create story conversation event links: ${error.message}`,
      );
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Remove a conversation event link from a story.
   */
  async delete(
    familyId: string,
    storyId: string,
    conversationEventId: string,
  ): Promise<void> {
    const { error } = await this.client
      .from(this.tableName)
      .delete()
      .eq('family_id', familyId)
      .eq('story_id', storyId)
      .eq('conversation_event_id', conversationEventId);

    if (error) {
      throw new Error(
        `Failed to delete story conversation event link: ${error.message}`,
      );
    }
  }

  /**
   * Remove all conversation event links for a story.
   */
  async deleteByStory(familyId: string, storyId: string): Promise<void> {
    const { error } = await this.client
      .from(this.tableName)
      .delete()
      .eq('family_id', familyId)
      .eq('story_id', storyId);

    if (error) {
      throw new Error(
        `Failed to delete conversation events for story: ${error.message}`,
      );
    }
  }

  /**
   * Get conversation event IDs for a story (convenience method).
   */
  async getConversationEventIds(
    familyId: string,
    storyId: string,
  ): Promise<string[]> {
    const links = await this.findByStory(familyId, storyId);
    return links.map((link) => link.conversationEventId);
  }

  private mapFromDb(row: any): StoryConversationEvent {
    return mapRowToCamelCase(row) as StoryConversationEvent;
  }
}
