import { SupabaseClient } from '@supabase/supabase-js';
import { Confidence, type Relationship } from '@sobremesa/shared-types';
import { getServiceClient } from '../client.js';
import { mapRowToCamelCase, mapRecordToSnakeCase } from '../base-repository.js';

/**
 * Repository for relationships between people.
 * Note: Does not extend BaseRepository as Relationship has a different structure.
 */
export class RelationshipRepository {
  protected client: SupabaseClient;
  protected tableName = 'relationships';

  constructor(client?: SupabaseClient) {
    this.client = client || getServiceClient();
  }

  /**
   * Find a relationship by ID.
   */
  async findById(familyId: string, id: string): Promise<Relationship | null> {
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
      throw new Error(`Failed to find relationship by id: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Find all relationships involving a person.
   */
  async findByPerson(familyId: string, personId: string): Promise<Relationship[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .or(`person_a_id.eq.${personId},person_b_id.eq.${personId}`)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find relationships by person: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find a relationship between two specific people.
   */
  async findBetween(
    familyId: string,
    personAId: string,
    personBId: string
  ): Promise<Relationship | null> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .or(
        `and(person_a_id.eq.${personAId},person_b_id.eq.${personBId}),and(person_a_id.eq.${personBId},person_b_id.eq.${personAId})`
      )
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      throw new Error(`Failed to find relationship between people: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Find or create a relationship between two people.
   */
  async findOrCreate(
    familyId: string,
    personAId: string,
    personBId: string,
    relationshipType: string,
    sourceEventId?: string,
    claimedBy?: string,
    confidence: Confidence = Confidence.MEDIUM
  ): Promise<Relationship> {
    // Check if relationship already exists
    const existing = await this.findBetween(familyId, personAId, personBId);

    if (existing) {
      return existing;
    }

    // Create new relationship
    return await this.insert({
      familyId,
      personAId,
      personBId,
      relationshipType,
      confidence,
      sourceEventId,
      claimedBy,
    });
  }

  /**
   * Insert a new relationship.
   */
  async insert(
    record: Omit<Relationship, 'id' | 'createdAt'>
  ): Promise<Relationship> {
    const dbRecord = this.mapToDb(record as Relationship);

    const { data, error } = await this.client
      .from(this.tableName)
      .insert(dbRecord)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to insert relationship: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Find all relationships for a family.
   */
  async findAll(familyId: string): Promise<Relationship[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find relationships: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find relationships by type.
   */
  async findByType(familyId: string, relationshipType: string): Promise<Relationship[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('relationship_type', relationshipType)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find relationships by type: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  private mapFromDb(row: Record<string, unknown>): Relationship {
    return mapRowToCamelCase<Relationship>(row);
  }

  private mapToDb(record: Relationship): Record<string, unknown> {
    return mapRecordToSnakeCase(record as unknown as Record<string, unknown>);
  }
}
