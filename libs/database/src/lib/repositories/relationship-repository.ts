import { SupabaseClient } from '@supabase/supabase-js';
import {
  Confidence,
  type Relationship,
  type RelationshipCategory,
  type RelationshipStatus,
} from '@sobremesa/shared-types';
import {
  normalizeRelationship,
  getRelationshipPerspective,
} from '@sobremesa/shared-types';
import { getServiceClient } from '../client.js';
import { mapRowToCamelCase, mapRecordToSnakeCase } from '../base-repository.js';

/**
 * Repository for relationships between people.
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
  async findByPerson(
    familyId: string,
    personId: string,
  ): Promise<Relationship[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .or(`person_a_id.eq.${personId},person_b_id.eq.${personId}`)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(
        `Failed to find relationships by person: ${error.message}`,
      );
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find a relationship between two specific people.
   */
  async findBetween(
    familyId: string,
    personAId: string,
    personBId: string,
  ): Promise<Relationship | null> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .or(
        `and(person_a_id.eq.${personAId},person_b_id.eq.${personBId}),and(person_a_id.eq.${personBId},person_b_id.eq.${personAId})`,
      )
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      throw new Error(
        `Failed to find relationship between people: ${error.message}`,
      );
    }

    return this.mapFromDb(data);
  }

  /**
   * Find or create a relationship between two people.
   * Automatically normalizes the relationship for consistent storage.
   */
  async findOrCreate(
    familyId: string,
    personAId: string,
    personBId: string,
    relationshipType: string,
    options?: {
      category?: RelationshipCategory;
      status?: RelationshipStatus;
      qualifier?: string;
      sourceEventId?: string;
      claimedBy?: string;
      confidence?: Confidence;
    },
  ): Promise<Relationship> {
    // Normalize the relationship
    const normalized = normalizeRelationship(
      personAId,
      personBId,
      relationshipType,
      options?.category,
    );

    // Check if relationship already exists (using normalized IDs)
    const existing = await this.findBetween(
      familyId,
      normalized.personAId,
      normalized.personBId,
    );

    if (existing) {
      return existing;
    }

    // Create new relationship with normalized values
    return await this.insert({
      familyId,
      personAId: normalized.personAId,
      personBId: normalized.personBId,
      relationshipType: normalized.relationshipType,
      category: normalized.category,
      status: options?.status || 'active',
      qualifier: options?.qualifier,
      confidence: options?.confidence || Confidence.MEDIUM,
      sourceEventId: options?.sourceEventId,
      claimedBy: options?.claimedBy,
    });
  }

  /**
   * Insert a new relationship.
   * Automatically normalizes the relationship for consistent storage.
   */
  async insert(
    record: Omit<Relationship, 'id' | 'createdAt'>,
  ): Promise<Relationship> {
    // Normalize the relationship
    const normalized = normalizeRelationship(
      record.personAId,
      record.personBId,
      record.relationshipType,
      record.category,
    );

    const dbRecord = this.mapToDb({
      ...record,
      personAId: normalized.personAId,
      personBId: normalized.personBId,
      relationshipType: normalized.relationshipType,
      category: normalized.category,
    } as Relationship);

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
   * Update a relationship's status.
   */
  async updateStatus(
    familyId: string,
    id: string,
    status: RelationshipStatus,
  ): Promise<Relationship> {
    const { data, error } = await this.client
      .from(this.tableName)
      .update({ status })
      .eq('family_id', familyId)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update relationship status: ${error.message}`);
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
  async findByType(
    familyId: string,
    relationshipType: string,
  ): Promise<Relationship[]> {
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

  /**
   * Find relationships by category.
   */
  async findByCategory(
    familyId: string,
    category: RelationshipCategory,
  ): Promise<Relationship[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('category', category)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(
        `Failed to find relationships by category: ${error.message}`,
      );
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find structural relationships (parent, spouse) for building the family tree.
   */
  async findTreeRelationships(familyId: string): Promise<Relationship[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .in('category', ['biological', 'legal'])
      .in('relationship_type', ['parent', 'spouse'])
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find tree relationships: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Get all relationships for a person, with types from their perspective.
   */
  async findByPersonWithPerspective(
    familyId: string,
    personId: string,
  ): Promise<
    Array<{
      relationship: Relationship;
      toPersonId: string;
      perspectiveType: string;
    }>
  > {
    const relationships = await this.findByPerson(familyId, personId);

    return relationships.map((rel) => {
      const perspective = getRelationshipPerspective(
        rel.personAId,
        rel.personBId,
        rel.relationshipType,
        personId,
      );

      return {
        relationship: rel,
        toPersonId: perspective.toPersonId,
        perspectiveType: perspective.relationshipType,
      };
    });
  }

  /**
   * Find parents of a person.
   */
  async findParents(
    familyId: string,
    personId: string,
  ): Promise<Relationship[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('person_b_id', personId) // personB is the child in parent relationships
      .eq('relationship_type', 'parent')
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find parents: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find children of a person.
   */
  async findChildren(
    familyId: string,
    personId: string,
  ): Promise<Relationship[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('person_a_id', personId) // personA is the parent in parent relationships
      .eq('relationship_type', 'parent')
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find children: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find spouse(s) of a person.
   */
  async findSpouses(
    familyId: string,
    personId: string,
  ): Promise<Relationship[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('relationship_type', 'spouse')
      .or(`person_a_id.eq.${personId},person_b_id.eq.${personId}`)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find spouses: ${error.message}`);
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
