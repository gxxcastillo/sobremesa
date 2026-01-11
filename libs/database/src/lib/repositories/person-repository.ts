import { SupabaseClient } from '@supabase/supabase-js';
import type { Person, ExtractedPerson } from '@sobremesa/shared-types';
import { BaseRepository, mapRowToCamelCase, mapRecordToSnakeCase } from '../base-repository.js';

/**
 * Repository for people mentioned in family history.
 */
export class PersonRepository extends BaseRepository<Person> {
  constructor(client?: SupabaseClient) {
    super('people', client);
  }

  /**
   * Find a person by exact name match.
   */
  async findByName(familyId: string, name: string): Promise<Person | null> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('redacted', false)
      .ilike('name', name)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      throw new Error(`Failed to find person by name: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Find a person by fuzzy matching on name or aliases.
   * Returns the best match or null if no match found.
   */
  async findByFuzzyMatch(
    familyId: string,
    name: string,
    aliases: string[] = []
  ): Promise<Person | null> {
    // Get all non-redacted people for this family
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('redacted', false);

    if (error) {
      throw new Error(`Failed to search people for fuzzy match: ${error.message}`);
    }

    if (!data || data.length === 0) {
      return null;
    }

    const nameLower = name.toLowerCase().trim();
    const aliasesLower = aliases.map((a) => a.toLowerCase().trim());
    const allSearchTerms = [nameLower, ...aliasesLower];

    // Check each person for a match
    for (const row of data) {
      const person = this.mapFromDb(row);
      const personNameLower = person.name.toLowerCase().trim();
      const personAliasesLower = (person.aliases || []).map((a) =>
        a.toLowerCase().trim()
      );
      const allPersonTerms = [personNameLower, ...personAliasesLower];

      // Check for exact matches
      for (const searchTerm of allSearchTerms) {
        for (const personTerm of allPersonTerms) {
          if (searchTerm === personTerm) {
            return person;
          }
        }
      }

      // Check for fuzzy matches (similarity > 0.8)
      for (const searchTerm of allSearchTerms) {
        for (const personTerm of allPersonTerms) {
          if (this.calculateSimilarity(searchTerm, personTerm) > 0.8) {
            return person;
          }
        }
      }
    }

    return null;
  }

  /**
   * Find or create a person, merging aliases if already exists.
   */
  async findOrCreate(
    familyId: string,
    extracted: ExtractedPerson,
    sourceEventId: string,
    createdBy?: string
  ): Promise<Person> {
    // Try to find existing person
    const existing = await this.findByFuzzyMatch(
      familyId,
      extracted.name,
      extracted.aliases
    );

    if (existing) {
      // Merge aliases
      const existingAliases = new Set(
        (existing.aliases || []).map((a) => a.toLowerCase().trim())
      );
      const newAliases = extracted.aliases.filter(
        (a) => !existingAliases.has(a.toLowerCase().trim())
      );

      if (newAliases.length > 0) {
        return await this.updateAliases(
          familyId,
          existing.id,
          [...existing.aliases, ...newAliases]
        );
      }

      return existing;
    }

    // Create new person
    const record: Omit<Person, 'id' | 'createdAt' | 'updatedAt'> = {
      familyId,
      name: extracted.name,
      aliases: extracted.aliases,
      birthYear: extracted.birthYear,
      birthYearConfidence: extracted.confidence,
      deathYear: extracted.deathYear,
      deathYearConfidence: extracted.confidence,
      firstMentionedEventId: sourceEventId,
      createdBy,
      redacted: false,
    };

    return await this.insert(record);
  }

  /**
   * Update a person's aliases.
   */
  async updateAliases(
    familyId: string,
    id: string,
    aliases: string[]
  ): Promise<Person> {
    const { data, error } = await this.client
      .from(this.tableName)
      .update({ aliases })
      .eq('family_id', familyId)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update person aliases: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Find all people for a family.
   */
  async findAllActive(familyId: string): Promise<Person[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('redacted', false)
      .order('name', { ascending: true });

    if (error) {
      throw new Error(`Failed to find people: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Calculate Levenshtein similarity between two strings (0 to 1).
   */
  private calculateSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    if (a.length === 0 || b.length === 0) return 0;

    const matrix: number[][] = [];

    // Initialize matrix
    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    // Fill matrix
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1, // insertion
            matrix[i - 1][j] + 1 // deletion
          );
        }
      }
    }

    const distance = matrix[b.length][a.length];
    const maxLength = Math.max(a.length, b.length);
    return 1 - distance / maxLength;
  }

  protected mapFromDb(row: Record<string, unknown>): Person {
    return mapRowToCamelCase<Person>(row);
  }

  protected mapToDb(record: Person): Record<string, unknown> {
    return mapRecordToSnakeCase(record as unknown as Record<string, unknown>);
  }
}
