import { SupabaseClient } from '@supabase/supabase-js';
import type { Image } from '@sobremesa/shared-types';
import {
  BaseRepository,
  mapRowToCamelCase,
  mapRecordToSnakeCase,
} from '../base-repository.js';

/**
 * Repository for images and documents.
 */
export class ImageRepository extends BaseRepository<Image> {
  constructor(client?: SupabaseClient) {
    super('images', client);
  }

  /**
   * Find an image by external file ID.
   */
  async findByExternalFileId(
    familyId: string,
    source: string,
    externalFileId: string
  ): Promise<Image | null> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('source', source)
      .eq('external_file_id', externalFileId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      throw new Error(
        `Failed to find image by external file ID: ${error.message}`
      );
    }

    return this.mapFromDb(data);
  }

  /**
   * Find images by source event ID.
   */
  async findBySourceEventId(
    familyId: string,
    sourceEventId: string
  ): Promise<Image[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('source_event_id', sourceEventId)
      .eq('redacted', false);

    if (error) {
      throw new Error(
        `Failed to find images by source event: ${error.message}`
      );
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find unanalyzed images for a family.
   */
  async findUnanalyzed(familyId: string, limit = 10): Promise<Image[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('analyzed', false)
      .eq('redacted', false)
      .order('created_at', { ascending: true })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to find unanalyzed images: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find images connected to a person.
   */
  async findByPerson(familyId: string, personId: string): Promise<Image[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('redacted', false)
      .contains('connected_people', [personId])
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find images by person: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find images connected to a story.
   */
  async findByStory(familyId: string, storyId: string): Promise<Image[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('redacted', false)
      .contains('connected_stories', [storyId])
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find images by story: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find recent images in a conversation (via source event).
   * Used to provide image context to Scribe.
   */
  async findRecentInConversation(
    familyId: string,
    conversationId: string,
    limit = 5
  ): Promise<Image[]> {
    // Query images joined with their source events to filter by conversation
    const { data, error } = await this.client
      .from(this.tableName)
      .select(
        `
        *,
        conversation_events!source_event_id (
          conversation_id
        )
      `
      )
      .eq('family_id', familyId)
      .eq('redacted', false)
      .eq('conversation_events.conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(
        `Failed to find recent images in conversation: ${error.message}`
      );
    }

    // Map and filter out any that didn't match the join
    return (data || [])
      .filter((row) => row.conversation_events !== null)
      .map((row) => {
        // Remove the joined data before mapping
        const { conversation_events: _conversation_events, ...imageRow } = row;
        return this.mapFromDb(imageRow);
      });
  }

  /**
   * Mark an image as analyzed with results.
   */
  async markAnalyzed(
    familyId: string,
    imageId: string,
    analysis: {
      description?: string;
      peopleCount?: number;
      estimatedEra?: string;
      visibleText?: string[];
      connectedPeople?: string[];
      connectedStories?: string[];
    }
  ): Promise<Image> {
    const updates: Record<string, unknown> = {
      analyzed: true,
      analyzed_at: new Date().toISOString(),
    };

    if (analysis.description !== undefined) {
      updates.analysis = { description: analysis.description };
    }
    if (analysis.peopleCount !== undefined) {
      updates.people_count = analysis.peopleCount;
    }
    if (analysis.estimatedEra !== undefined) {
      updates.estimated_era = analysis.estimatedEra;
    }
    if (analysis.visibleText !== undefined) {
      updates.visible_text = analysis.visibleText;
    }
    if (analysis.connectedPeople !== undefined) {
      updates.connected_people = analysis.connectedPeople;
    }
    if (analysis.connectedStories !== undefined) {
      updates.connected_stories = analysis.connectedStories;
    }

    const { data, error } = await this.client
      .from(this.tableName)
      .update(updates)
      .eq('family_id', familyId)
      .eq('id', imageId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to mark image as analyzed: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Add connected people to an image (merges with existing).
   */
  async addConnectedPeople(
    familyId: string,
    imageId: string,
    personIds: string[]
  ): Promise<Image> {
    // First get current connected people
    const image = await this.findById(familyId, imageId);
    if (!image) {
      throw new Error(`Image not found: ${imageId}`);
    }

    // Merge and dedupe
    const existingIds = new Set(image.connectedPeople || []);
    for (const id of personIds) {
      existingIds.add(id);
    }

    const { data, error } = await this.client
      .from(this.tableName)
      .update({
        connected_people: Array.from(existingIds),
        updated_at: new Date().toISOString(),
      })
      .eq('family_id', familyId)
      .eq('id', imageId)
      .select()
      .single();

    if (error) {
      throw new Error(
        `Failed to add connected people to image: ${error.message}`
      );
    }

    return this.mapFromDb(data);
  }

  /**
   * Update image context (caption/description from user messages).
   */
  async addContext(
    familyId: string,
    imageId: string,
    context: string,
    sourceEventId: string
  ): Promise<Image> {
    const image = await this.findById(familyId, imageId);
    if (!image) {
      throw new Error(`Image not found: ${imageId}`);
    }

    // Append context to analysis if it exists
    const existingAnalysis = (image.analysis || {}) as Record<string, unknown>;
    const existingContexts = (existingAnalysis.userContexts || []) as Array<{
      text: string;
      sourceEventId: string;
    }>;

    const updatedAnalysis = {
      ...existingAnalysis,
      userContexts: [...existingContexts, { text: context, sourceEventId }],
    };

    const { data, error } = await this.client
      .from(this.tableName)
      .update({
        analysis: updatedAnalysis,
        updated_at: new Date().toISOString(),
      })
      .eq('family_id', familyId)
      .eq('id', imageId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to add context to image: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Create an image record from a conversation event.
   */
  async createFromEvent(
    familyId: string,
    sourceEventId: string,
    params: {
      source: string;
      externalFileId: string;
      fileType: 'photo' | 'document' | 'video';
      fileSizeBytes?: number;
      captionOriginal?: string;
      languageOriginal?: string;
      sharedBy?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<Image> {
    const record: Omit<Image, 'id' | 'createdAt' | 'updatedAt'> = {
      familyId,
      source: params.source,
      externalFileId: params.externalFileId,
      fileType: params.fileType,
      fileSizeBytes: params.fileSizeBytes,
      captionOriginal: params.captionOriginal,
      languageOriginal: params.languageOriginal as Image['languageOriginal'],
      sourceEventId,
      sharedBy: params.sharedBy,
      visibleText: [],
      connectedStories: [],
      connectedPeople: [],
      analyzed: false,
      redacted: false,
    };

    return await this.insert(record);
  }

  protected mapFromDb(row: Record<string, unknown>): Image {
    return mapRowToCamelCase<Image>(row);
  }

  protected mapToDb(record: Image): Record<string, unknown> {
    return mapRecordToSnakeCase(record as unknown as Record<string, unknown>);
  }
}
