import { SupabaseClient } from '@supabase/supabase-js';
import type { Story, Confidence, LanguageCode } from '@sobremesa/shared-types';
import {
  BaseRepository,
  mapRowToCamelCase,
  mapRecordToSnakeCase,
} from '../base-repository.js';

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
   * Uses the story_people join table.
   */
  async findByPerson(familyId: string, personId: string): Promise<Story[]> {
    // Query via story_people join table
    const { data, error } = await this.client
      .from('story_people')
      .select('stories!inner(*)')
      .eq('family_id', familyId)
      .eq('person_id', personId)
      .eq('stories.redacted', false)
      .order('stories.created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find stories by person: ${error.message}`);
    }

    return (data || []).map((row: any) => this.mapFromDb(row.stories));
  }

  /**
   * Find a story by conversation event ID.
   * Uses the story_conversation_events join table.
   */
  async findByConversationEvent(
    familyId: string,
    conversationEventId: string,
  ): Promise<Story | null> {
    // Query via story_conversation_events join table
    const { data, error } = await this.client
      .from('story_conversation_events')
      .select('stories!inner(*)')
      .eq('family_id', familyId)
      .eq('conversation_event_id', conversationEventId)
      .eq('stories.redacted', false)
      .maybeSingle();

    if (error) {
      throw new Error(
        `Failed to find story by conversation event: ${error.message}`,
      );
    }

    if (!data) {
      return null;
    }

    return this.mapFromDb((data as any).stories);
  }

  /**
   * Create a story from extracted data.
   * Note: After creating, use StoryConversationEventsRepository to link conversation events.
   */
  async createFromExtracted(
    familyId: string,
    story: {
      title?: string;
      content: string;
      themes: string[];
      timeframe?: string;
    },
    conversationEventId: string,
    language: LanguageCode,
    sharedBy?: string,
    extractionVersion?: string,
  ): Promise<Story> {
    // Note: Entity associations use join tables (story_people, story_places, story_events)
    // Note: Source provenance uses story_conversation_events join table
    const record: Omit<
      Story,
      'id' | 'createdAt' | 'updatedAt' | 'conversationEventIds'
    > = {
      familyId,
      title: story.title,
      contentOriginal: story.content,
      contentLanguage: language,
      themes: story.themes,
      timeframe: story.timeframe,
      completeness: 'partial',
      confidence: 'medium' as Confidence,
      sharedBy,
      redacted: false,
      extractionVersion,
    };

    const created = await this.insert(record);

    // Return with conversationEventIds populated for convenience (caller should also link via join table)
    return { ...created, conversationEventIds: [conversationEventId] };
  }

  /**
   * Append additional content to an existing story.
   * Note: After appending, use StoryConversationEventsRepository to link the new conversation event.
   */
  async appendToStory(
    familyId: string,
    storyId: string,
    additionalContent: string,
    conversationEventId: string,
  ): Promise<Story> {
    // First fetch the existing story
    const existing = await this.findById(familyId, storyId);
    if (!existing) {
      throw new Error(`Story not found: ${storyId}`);
    }

    // Append content only (source events tracked via story_conversation_events join table)
    const updates = {
      content_original: existing.contentOriginal + '\n\n' + additionalContent,
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

    const updated = this.mapFromDb(data);
    // Return with new conversationEventId appended for convenience (caller should also link via join table)
    return {
      ...updated,
      conversationEventIds: [
        ...(existing.conversationEventIds || []),
        conversationEventId,
      ],
    };
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
