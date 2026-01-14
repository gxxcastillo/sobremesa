import { SupabaseClient } from '@supabase/supabase-js';
import { getServiceClient } from './client';

/**
 * Base repository with common database operations.
 * All repositories should extend this class.
 */
export abstract class BaseRepository<
  T extends { id: string; familyId: string }
> {
  protected client: SupabaseClient;
  protected tableName: string;

  constructor(tableName: string, client?: SupabaseClient) {
    this.tableName = tableName;
    this.client = client || getServiceClient();
  }

  /**
   * Find a record by ID within a family.
   */
  async findById(familyId: string, id: string): Promise<T | null> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null; // Not found
      }
      throw new Error(
        `Failed to find ${this.tableName} by id: ${error.message}`
      );
    }

    return this.mapFromDb(data);
  }

  /**
   * Find all records for a family.
   */
  async findAll(
    familyId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<T[]> {
    let query = this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .order('created_at', { ascending: false });

    if (options?.limit) {
      query = query.limit(options.limit);
    }

    if (options?.offset) {
      query = query.range(
        options.offset,
        options.offset + (options.limit || 100) - 1
      );
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to find all ${this.tableName}: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Insert a new record.
   */
  async insert(record: Omit<T, 'id' | 'createdAt' | 'updatedAt'>): Promise<T> {
    const dbRecord = this.mapToDb(record as T);

    const { data, error } = await this.client
      .from(this.tableName)
      .insert(dbRecord)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to insert ${this.tableName}: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Update an existing record.
   */
  async update(familyId: string, id: string, updates: Partial<T>): Promise<T> {
    const dbUpdates = this.mapToDb(updates as T);

    const { data, error } = await this.client
      .from(this.tableName)
      .update(dbUpdates)
      .eq('family_id', familyId)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update ${this.tableName}: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Soft delete a record (set redacted = true).
   */
  async softDelete(
    familyId: string,
    id: string,
    redactedBy: string,
    reason?: string
  ): Promise<void> {
    const { error } = await this.client
      .from(this.tableName)
      .update({
        redacted: true,
        redacted_at: new Date().toISOString(),
        redacted_by: redactedBy,
        redaction_reason: reason,
      })
      .eq('family_id', familyId)
      .eq('id', id);

    if (error) {
      throw new Error(
        `Failed to soft delete ${this.tableName}: ${error.message}`
      );
    }
  }

  /**
   * Map a database row to the domain model.
   * Override in subclasses for custom mapping.
   */
  protected abstract mapFromDb(row: Record<string, unknown>): T;

  /**
   * Map a domain model to database format.
   * Override in subclasses for custom mapping.
   */
  protected abstract mapToDb(record: T): Record<string, unknown>;
}

/**
 * Convert snake_case to camelCase.
 */
export function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Convert camelCase to snake_case.
 */
export function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Convert all keys in an object from snake_case to camelCase.
 */
export function mapRowToCamelCase<T>(row: Record<string, unknown>): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    result[snakeToCamel(key)] = value;
  }
  return result as T;
}

/**
 * Convert all keys in an object from camelCase to snake_case.
 */
export function mapRecordToSnakeCase(
  record: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      result[camelToSnake(key)] = value;
    }
  }
  return result;
}
