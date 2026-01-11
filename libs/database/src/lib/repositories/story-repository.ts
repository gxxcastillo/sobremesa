import { SupabaseClient } from '@supabase/supabase-js';
import type { Story, Confidence, LanguageCode } from '@sobremesa/shared-types';
import { BaseRepository, mapRowToCamelCase, mapRecordToSnakeCase } from '../base-repository.js';

/**
 * Repository for coherent narrative fragments.
 */
export class StoryRepository extends BaseRepository<Story> {
  constructor(client?: SupabaseClient) {
    super('stories', client);
  }

  /**
   * Find a story by title.
   */
  async findByTitle(familyId: string, title: string): Promise<Story | null> {
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
      throw new Error(`Failed to find story by title: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Find stories by theme.
   */
  async findByTheme(familyId: string, theme: string): Promise<Story[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('redacted', false)
      .contains('themes', [theme])
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find stories by theme: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find stories involving a specific person.
   */
  async findByPerson(familyId: string, personId: string): Promise<Story[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('redacted', false)
      .contains('people', [personId])
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find stories by person: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find a story by source event ID.
   */
  async findBySourceEvent(familyId: string, sourceEventId: string): Promise<Story | null> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('redacted', false)
      .contains('source_event_ids', [sourceEventId])
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      throw new Error(`Failed to find story by source event: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Create a story from extracted data.
   */
  async createFromExtracted(
    familyId: string,
    story: {
      title?: string;
      content: string;
      themes: string[];
      timeframe?: string;
    },
    peopleIds: string[],
    placeIds: string[],
    eventIds: string[],
    sourceEventId: string,
    language: LanguageCode,
    sharedBy?: string
  ): Promise<Story> {
    const record: Omit<Story, 'id' | 'createdAt' | 'updatedAt'> = {
      familyId,
      title: story.title,
      contentOriginal: story.content,
      contentLanguage: language,
      themes: story.themes,
      timeframe: story.timeframe,
      completeness: 'partial',
      confidence: 'medium' as Confidence,
      people: peopleIds,
      places: placeIds,
      events: eventIds,
      sourceEventIds: [sourceEventId],
      sharedBy,
      redacted: false,
    };

    return await this.insert(record);
  }

  /**
   * Append additional content to an existing story.
   */
  async appendToStory(
    familyId: string,
    storyId: string,
    additionalContent: string,
    sourceEventId: string
  ): Promise<Story> {
    // First fetch the existing story
    const existing = await this.findById(familyId, storyId);
    if (!existing) {
      throw new Error(`Story not found: ${storyId}`);
    }

    // Append content and source event
    const updates = {
      content_original: existing.contentOriginal + '\n\n' + additionalContent,
      source_event_ids: [...existing.sourceEventIds, sourceEventId],
    };

    const { data, error } = await this.client
      .from(this.tableName)
      .update(updates)
      .eq('family_id', familyId)
      .eq('id', storyId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to append to story: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Find all stories for a family.
   */
  async findAllActive(familyId: string): Promise<Story[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('redacted', false)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find stories: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  protected mapFromDb(row: Record<string, unknown>): Story {
    return mapRowToCamelCase<Story>(row);
  }

  protected mapToDb(record: Story): Record<string, unknown> {
    return mapRecordToSnakeCase(record as unknown as Record<string, unknown>);
  }
}
