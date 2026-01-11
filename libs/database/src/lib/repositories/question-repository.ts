import { SupabaseClient } from '@supabase/supabase-js';
import type { Question, GeneratedQuestion } from '@sobremesa/shared-types';
import { getServiceClient } from '../client.js';
import { mapRowToCamelCase, mapRecordToSnakeCase } from '../base-repository.js';

/**
 * Repository for questions in the facilitator queue.
 * Note: Does not extend BaseRepository as Question has a different structure.
 */
export class QuestionRepository {
  protected client: SupabaseClient;
  protected tableName = 'questions';

  constructor(client?: SupabaseClient) {
    this.client = client || getServiceClient();
  }

  /**
   * Find a question by ID.
   */
  async findById(familyId: string, id: string): Promise<Question | null> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      throw new Error(`Failed to find question by id: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Find pending (proposed) questions by priority.
   */
  async findPending(familyId: string, limit = 10): Promise<Question[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('status', 'proposed')
      .order('priority', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to find pending questions: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find questions by status.
   */
  async findByStatus(
    familyId: string,
    status: Question['status']
  ): Promise<Question[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('status', status)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find questions by status: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find unanswered questions (proposed or asked).
   */
  async findUnanswered(familyId: string): Promise<Question[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .in('status', ['proposed', 'asked'])
      .order('priority', { ascending: false });

    if (error) {
      throw new Error(`Failed to find unanswered questions: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Create a question from generated data.
   */
  async createFromGenerated(
    familyId: string,
    generated: GeneratedQuestion,
    sourceMessageId?: string
  ): Promise<Question> {
    const record = {
      family_id: familyId,
      content_original: generated.content,
      language_original: generated.language,
      origin: generated.origin,
      status: 'proposed',
      priority: generated.priority,
      source_message_id: sourceMessageId,
    };

    const { data, error } = await this.client
      .from(this.tableName)
      .insert(record)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create question: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Insert a new question.
   */
  async insert(
    record: Omit<Question, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<Question> {
    const dbRecord = this.mapToDb(record as Question);

    const { data, error } = await this.client
      .from(this.tableName)
      .insert(dbRecord)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to insert question: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Mark a question as asked.
   */
  async markAsked(
    familyId: string,
    id: string,
    askedByIdentityId?: string
  ): Promise<Question> {
    const updates: Record<string, unknown> = {
      status: 'asked',
      asked_at: new Date().toISOString(),
    };

    if (askedByIdentityId) {
      updates['asked_by_identity_id'] = askedByIdentityId;
    }

    const { data, error } = await this.client
      .from(this.tableName)
      .update(updates)
      .eq('family_id', familyId)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to mark question as asked: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Mark a question as answered.
   */
  async markAnswered(
    familyId: string,
    id: string,
    answerMessageId?: string
  ): Promise<Question> {
    const updates: Record<string, unknown> = {
      status: 'answered',
      answered_at: new Date().toISOString(),
    };

    if (answerMessageId) {
      updates['answer_message_id'] = answerMessageId;
    }

    const { data, error } = await this.client
      .from(this.tableName)
      .update(updates)
      .eq('family_id', familyId)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to mark question as answered: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Retire a question.
   */
  async retire(familyId: string, id: string): Promise<Question> {
    const { data, error } = await this.client
      .from(this.tableName)
      .update({ status: 'retired' })
      .eq('family_id', familyId)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to retire question: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Find all questions for a family.
   */
  async findAll(familyId: string): Promise<Question[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find questions: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  private mapFromDb(row: Record<string, unknown>): Question {
    return mapRowToCamelCase<Question>(row);
  }

  private mapToDb(record: Question): Record<string, unknown> {
    return mapRecordToSnakeCase(record as unknown as Record<string, unknown>);
  }
}
