import type { DatabaseClient } from '../client';
import type { Story, LanguageCode } from '@sobremesa/shared-types';
import {
  BaseRepository,
  mapRowToCamelCase,
  mapRecordToSnakeCase,
} from '../base-repository.js';
import {
  wordOverlapSimilarity,
  jaccardSimilarity,
} from '../text-similarity.js';

const STORY_MATCH_THRESHOLD = 0.55;
const TITLE_ANCHOR_THRESHOLD = 0.6;
const UNTITLED_CONTENT_THRESHOLD = 0.55;
const THEME_ANCHOR_THRESHOLD = 0.5;

export type StoryContributionOutcome =
  | 'created'
  | 'appended'
  | 'already_applied';

export interface StoryContribution {
  storyId: string;
  outcome: StoryContributionOutcome;
}

/**
 * Repository for coherent narrative fragments.
 */
export class StoryRepository extends BaseRepository<Story> {
  constructor(client: DatabaseClient) {
    super(client, 'stories');
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
   * Find a similar story using word-overlap scoring on title, content, and themes.
   */
  async findSimilar(
    familyId: string,
    title: string | undefined,
    content: string,
    personIds: string[],
    themes: string[],
  ): Promise<Story | null> {
    let candidates: Story[];

    if (personIds.length > 0) {
      const { data: storyPeopleData, error: spError } = await this.client
        .from('story_people')
        .select('story_id')
        .eq('family_id', familyId)
        .in('person_id', personIds);

      if (spError) {
        throw new Error(`Failed to query story_people: ${spError.message}`);
      }

      if (!storyPeopleData || storyPeopleData.length === 0) {
        candidates = await this.findAllActive(familyId);
      } else {
        const candidateStoryIds = [
          ...new Set(storyPeopleData.map((row) => row.story_id)),
        ];

        const { data, error } = await this.client
          .from(this.tableName)
          .select('*')
          .eq('family_id', familyId)
          .eq('redacted', false)
          .in('id', candidateStoryIds);

        if (error) {
          throw new Error(
            `Failed to fetch candidate stories: ${error.message}`,
          );
        }

        candidates = (data || []).map((row) => this.mapFromDb(row));
      }
    } else {
      candidates = await this.findAllActive(familyId);
    }

    if (candidates.length === 0) return null;

    // Batch-fetch person links for all candidates (avoids N+1 queries)
    const personOverlapSet = new Set<string>();
    if (personIds.length > 0) {
      const candidateIds = candidates.map((c) => c.id);
      const { data: spBatch } = await this.client
        .from('story_people')
        .select('story_id, person_id')
        .eq('family_id', familyId)
        .in('story_id', candidateIds)
        .in('person_id', personIds);

      for (const row of spBatch || []) {
        personOverlapSet.add(row.story_id);
      }
    }

    const contentSnippet = content.slice(0, 200);

    let bestMatch: Story | null = null;
    let bestScore = 0;

    for (const candidate of candidates) {
      const titleSimilarity =
        title && candidate.title
          ? wordOverlapSimilarity(title, candidate.title)
          : 0;
      const candidateSnippet = (candidate.contentOriginal || '').slice(0, 200);
      const contentSimilarity = wordOverlapSimilarity(
        contentSnippet,
        candidateSnippet,
      );
      const themeSimilarity = jaccardSimilarity(themes, candidate.themes || []);
      const hasPersonOverlap = personOverlapSet.has(candidate.id);

      const hasTitleAnchor = titleSimilarity >= TITLE_ANCHOR_THRESHOLD;
      const hasPersonThemeAnchor =
        hasPersonOverlap && themeSimilarity >= THEME_ANCHOR_THRESHOLD;
      const hasUntitledAnchor =
        !title &&
        !candidate.title &&
        hasPersonThemeAnchor &&
        contentSimilarity >= UNTITLED_CONTENT_THRESHOLD;

      // Precision over recall: title/content similarity alone is not enough for
      // untitled stories. A merge needs either a real title anchor or corroborated
      // person+theme overlap.
      if (!hasTitleAnchor && !hasUntitledAnchor) {
        continue;
      }

      let score = 0;
      if (title && candidate.title) {
        score += titleSimilarity * 0.4;
      }
      score += contentSimilarity * 0.35;
      score += themeSimilarity * 0.25;
      if (hasPersonOverlap) {
        score += 0.15;
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = candidate;
      }
    }

    return bestScore >= STORY_MATCH_THRESHOLD ? bestMatch : null;
  }

  /**
   * Record one source message's story contribution: append it to a similar
   * existing story, or create a new one, and link the message -- atomically,
   * via the `persist_story_contribution` database function.
   *
   * Idempotent per source message: if the message is already linked to a
   * story (an earlier attempt committed, or the message is being
   * reprocessed), nothing is written and the outcome is `'already_applied'`.
   * That check runs before similarity matching too, since a retry would
   * otherwise match the story its own first attempt created.
   */
  async findOrCreate(
    familyId: string,
    story: {
      title?: string;
      content: string;
      themes: string[];
      timeframe?: string;
    },
    personIds: string[],
    conversationEventId: string,
    language: LanguageCode,
    sharedBy?: string,
    extractionVersion?: string,
  ): Promise<StoryContribution> {
    const contributedStoryId = await this.findContributedStoryId(
      familyId,
      conversationEventId,
    );
    if (contributedStoryId) {
      return { storyId: contributedStoryId, outcome: 'already_applied' };
    }

    const existing = await this.findSimilar(
      familyId,
      story.title,
      story.content,
      personIds,
      story.themes,
    );

    const { data, error } = await this.client
      .rpc('persist_story_contribution', {
        p_family_id: familyId,
        p_conversation_event_id: conversationEventId,
        p_target_story_id: existing?.id ?? null,
        p_title: story.title ?? null,
        p_content: story.content,
        p_content_language: language,
        p_themes: story.themes,
        p_timeframe: story.timeframe ?? null,
        p_shared_by: sharedBy ?? null,
        p_extraction_version: extractionVersion ?? null,
      })
      .single<{ story_id: string; outcome: StoryContributionOutcome }>();

    if (error) {
      throw new Error(`Failed to persist story contribution: ${error.message}`);
    }

    return { storyId: data.story_id, outcome: data.outcome };
  }

  /**
   * The story a source message already contributed to, if any. Includes
   * redacted stories: a contribution that happened still happened.
   */
  async findContributedStoryId(
    familyId: string,
    conversationEventId: string,
  ): Promise<string | null> {
    const { data, error } = await this.client
      .from('story_conversation_events')
      .select('story_id')
      .eq('family_id', familyId)
      .eq('conversation_event_id', conversationEventId)
      .order('created_at', { ascending: true })
      .limit(1);

    if (error) {
      throw new Error(`Failed to look up story contribution: ${error.message}`);
    }

    return data?.[0]?.story_id ?? null;
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
