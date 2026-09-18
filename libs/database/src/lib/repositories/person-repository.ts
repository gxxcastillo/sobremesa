import type { DatabaseClient } from '../client';
import type { Person, ExtractedPerson } from '@sobremesa/shared-types';
import {
  classifyPersonName,
  isSpeakerRelativeTerm,
  normalizeNameKey,
} from '@sobremesa/shared-utils';
import {
  BaseRepository,
  mapRowToCamelCase,
  mapRecordToSnakeCase,
} from '../base-repository.js';

/**
 * Match result with confidence level.
 */
export interface PersonMatchResult {
  person: Person;
  confidence: 'high' | 'medium' | 'low';
  matchReason: string;
}

/**
 * Repository for people mentioned in family history.
 */
export class PersonRepository extends BaseRepository<Person> {
  constructor(client: DatabaseClient) {
    super(client, 'people');
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
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to find person by name: ${error.message}`);
    }

    return data ? this.mapFromDb(data) : null;
  }

  /**
   * Find a person by fuzzy matching on name or aliases.
   * Returns the best match or null if no match found.
   */
  async findByFuzzyMatch(
    familyId: string,
    name: string,
    aliases: string[] = [],
  ): Promise<Person | null> {
    const result = await this.findBestMatch(familyId, name, aliases);
    return result?.person ?? null;
  }

  /**
   * Find the best matching person with confidence level.
   * Matching strategy (in order of confidence):
   * 1. Exact match on name or alias → high confidence
   * 2. First-name match with single result → medium confidence
   * 3. Fuzzy match (>0.8 similarity) → medium confidence
   * 4. First-name match with multiple results → returns null (ambiguous)
   */
  async findBestMatch(
    familyId: string,
    name: string,
    aliases: string[] = [],
  ): Promise<PersonMatchResult | null> {
    // Get all non-redacted, non-placeholder people for this family
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('redacted', false)
      .or('is_placeholder.is.null,is_placeholder.eq.false');

    if (error) {
      throw new Error(
        `Failed to search people for fuzzy match: ${error.message}`,
      );
    }

    if (!data || data.length === 0) {
      return null;
    }

    const nameLower = name.toLowerCase().trim();
    const aliasesLower = aliases.map((a) => a.toLowerCase().trim());
    // Speaker-relative terms ("mi tía", "my mom") name a different person for
    // every speaker, so no caller may match on one here -- even a caller
    // that (unlike Registrar's people loop) forgot to filter its own input.
    const allSearchTerms = [nameLower, ...aliasesLower].filter(
      (t) => !isSpeakerRelativeTerm(t),
    );

    // Descriptions ("Ralph's sister", "la tía de Juan", "the neighbor") may only match
    // exactly (pass 1) — they must never first-name- or fuzzy-match a real person.
    const looseTerms = allSearchTerms.filter(
      (t) => classifyPersonName(t) === null,
    );

    const people = data.map((row) => this.mapFromDb(row));

    // Pass 1: Exact match on name or alias (high confidence). Compared via
    // normalizeNameKey so a curly-apostrophe/accent variant of the same
    // description (routine LLM output) still exact-matches instead of
    // spawning a duplicate placeholder person.
    const allSearchKeys = allSearchTerms.map((t) => normalizeNameKey(t));
    for (const person of people) {
      const personNameKey = normalizeNameKey(person.name);
      const personAliasKeys = (person.aliases || []).map((a) =>
        normalizeNameKey(a),
      );
      const allPersonKeys = [personNameKey, ...personAliasKeys];

      for (const searchTerm of allSearchKeys) {
        for (const personTerm of allPersonKeys) {
          if (searchTerm === personTerm) {
            return {
              person,
              confidence: 'high',
              matchReason: `exact match: "${searchTerm}" = "${personTerm}"`,
            };
          }
        }
      }
    }

    // Pass 2: First-name match (check if search term is first name of a person)
    const firstNameMatches: Person[] = [];
    for (const person of people) {
      const personFirstName = person.name.toLowerCase().trim().split(' ')[0];

      for (const searchTerm of looseTerms) {
        // Check if search term matches first name
        if (searchTerm === personFirstName) {
          firstNameMatches.push(person);
          break;
        }
        // Also check if person's first name matches any search term's first name
        const searchFirstName = searchTerm.split(' ')[0];
        if (
          searchFirstName === personFirstName &&
          searchFirstName.length >= 3
        ) {
          firstNameMatches.push(person);
          break;
        }
      }
    }

    if (firstNameMatches.length === 1) {
      // Unambiguous first-name match
      return {
        person: firstNameMatches[0],
        confidence: 'medium',
        matchReason: `first-name match: "${nameLower}" → "${firstNameMatches[0].name}"`,
      };
    }

    // Pass 3: Fuzzy match (Levenshtein similarity > 0.8). A stored alias that
    // is itself a description (e.g. "Mario's son") must be excluded here too
    // -- otherwise a new, unrelated description could fuzzy-match it and
    // merge into the wrong person.
    for (const person of people) {
      const personNameLower = person.name.toLowerCase().trim();
      const personLooseAliases = (person.aliases || [])
        .map((a) => a.toLowerCase().trim())
        .filter((a) => classifyPersonName(a) === null);
      const allPersonTerms = [personNameLower, ...personLooseAliases];

      for (const searchTerm of looseTerms) {
        for (const personTerm of allPersonTerms) {
          const similarity = this.calculateSimilarity(searchTerm, personTerm);
          if (similarity > 0.8) {
            return {
              person,
              confidence: 'medium',
              matchReason: `fuzzy match: "${searchTerm}" ~ "${personTerm}" (${(
                similarity * 100
              ).toFixed(0)}%)`,
            };
          }
        }
      }
    }

    // Pass 4: Multiple first-name matches = ambiguous, don't match
    if (firstNameMatches.length > 1) {
      // Could log this for potential manual review
      return null;
    }

    return null;
  }

  /**
   * Find or create a person, merging aliases if already exists.
   */
  /**
   * Create a new person without checking for existing matches.
   * Use this when entity matching has already been performed.
   */
  async createNew(
    familyId: string,
    extracted: ExtractedPerson,
    conversationEventId?: string,
    createdBy?: string,
    extractionVersion?: string,
  ): Promise<Person> {
    const record: Omit<Person, 'id' | 'createdAt' | 'updatedAt'> = {
      familyId,
      name: extracted.name,
      aliases: extracted.aliases.filter(
        (alias) => !isSpeakerRelativeTerm(alias),
      ),
      birthYear: extracted.birthYear,
      birthYearConfidence: extracted.confidence,
      deathYear: extracted.deathYear,
      deathYearConfidence: extracted.confidence,
      firstMentionedEventId: conversationEventId,
      createdBy,
      redacted: false,
      isPlaceholder: classifyPersonName(extracted.name) !== null,
      extractionVersion,
    };

    return await this.insert(record);
  }

  async findOrCreate(
    familyId: string,
    extracted: ExtractedPerson,
    conversationEventId: string,
    createdBy?: string,
    extractionVersion?: string,
  ): Promise<Person> {
    // Try to find existing person
    const existing = await this.findByFuzzyMatch(
      familyId,
      extracted.name,
      extracted.aliases,
    );

    if (existing) {
      // Merge aliases
      const existingAliases = new Set(
        (existing.aliases || []).map((a) => a.toLowerCase().trim()),
      );
      const newAliases = extracted.aliases.filter(
        (a) => !existingAliases.has(a.toLowerCase().trim()),
      );

      if (newAliases.length > 0) {
        return await this.updateAliases(familyId, existing.id, [
          ...existing.aliases,
          ...newAliases,
        ]);
      }

      return existing;
    }

    // Create new person
    return await this.createNew(
      familyId,
      extracted,
      conversationEventId,
      createdBy,
      extractionVersion,
    );
  }

  /**
   * Update a person's aliases.
   */
  async updateAliases(
    familyId: string,
    id: string,
    aliases: string[],
  ): Promise<Person> {
    const durableAliases = aliases.filter(
      (alias) => !isSpeakerRelativeTerm(alias),
    );
    const { data, error } = await this.client
      .from(this.tableName)
      .update({ aliases: durableAliases })
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
   * Update a person's name and optionally add the old name as an alias.
   * Used when an identity claim reveals the real name for a descriptive reference.
   */
  async updateName(
    familyId: string,
    id: string,
    newName: string,
    addOldNameAsAlias = true,
  ): Promise<Person> {
    // First get the current person to preserve their old name
    const current = await this.findById(familyId, id);
    if (!current) {
      throw new Error(`Person not found: ${id}`);
    }

    const updates: Record<string, unknown> = { name: newName };

    if (addOldNameAsAlias && current.name !== newName) {
      const newAliases = [
        ...new Set(
          [...(current.aliases || []), current.name].filter(
            (alias) => !isSpeakerRelativeTerm(alias),
          ),
        ),
      ];
      updates.aliases = newAliases;
    }

    const { data, error } = await this.client
      .from(this.tableName)
      .update(updates)
      .eq('family_id', familyId)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update person name: ${error.message}`);
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
   * Create a placeholder person for an unknown individual in the family tree.
   * Used when we know a relationship exists but don't know the intermediate people.
   *
   * @param familyId - The family this person belongs to
   * @param description - A description like "parent of Maria" or "parent of Juan and Maria's parents"
   * @param relatedToPersonIds - IDs of people this placeholder is related to (for potential future merging)
   * @param conversationEventId - The conversation event that led to this placeholder's creation
   * @param createdBy - Who created this placeholder
   * @param extractionVersion - Version of extraction logic (for event sourcing)
   */
  async createPlaceholder(
    familyId: string,
    description: string,
    relatedToPersonIds: string[],
    conversationEventId?: string,
    createdBy?: string,
    extractionVersion?: string,
  ): Promise<Person> {
    const record: Omit<Person, 'id' | 'createdAt' | 'updatedAt'> = {
      familyId,
      name: 'Unknown',
      // A speaker-relative description ("mi papá") is deliberately NOT
      // stored. `findPlaceholderByDescription` looks placeholders up by this
      // alias, so storing it would make every later "mi papá" -- from any
      // speaker -- reuse this placeholder: a false merge of different
      // people's fathers. Skipping dedup for these descriptions is the
      // intended behavior (spec/data-model.md: speaker-relative placeholders
      // are never reused across mentions), not a missed dedup.
      aliases: [
        ...(!isSpeakerRelativeTerm(description) ? [description] : []),
        ...relatedToPersonIds.map((id) => `related-to:${id}`),
      ],
      isPlaceholder: true,
      firstMentionedEventId: conversationEventId,
      createdBy,
      redacted: false,
      extractionVersion,
    };

    return await this.insert(record);
  }

  /**
   * Find a placeholder person whose `name` (never its aliases -- placeholder
   * rows carry speaker-relative aliases like "mi papá", which name a
   * different person per speaker) exactly matches by normalized key.
   * Used to reuse a relational placeholder (e.g. "Ricardo Hermoso's father")
   * across mentions instead of minting a duplicate row each time.
   */
  async findPlaceholderByNormalizedName(
    familyId: string,
    name: string,
  ): Promise<Person | null> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('is_placeholder', true)
      .eq('redacted', false);

    if (error) {
      throw new Error(`Failed to find placeholder by name: ${error.message}`);
    }

    if (!data || data.length === 0) {
      return null;
    }

    const targetKey = normalizeNameKey(name);
    const match = data.find(
      (row) => normalizeNameKey(row.name as string) === targetKey,
    );

    return match ? this.mapFromDb(match) : null;
  }

  /**
   * Find a placeholder person by their relationship description.
   * Used to avoid creating duplicate placeholders.
   */
  async findPlaceholderByDescription(
    familyId: string,
    description: string,
  ): Promise<Person | null> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('is_placeholder', true)
      .eq('redacted', false)
      .contains('aliases', [description]);

    if (error) {
      throw new Error(`Failed to find placeholder: ${error.message}`);
    }

    if (!data || data.length === 0) {
      return null;
    }

    return this.mapFromDb(data[0]);
  }

  /**
   * Find or create a placeholder person.
   */
  async findOrCreatePlaceholder(
    familyId: string,
    description: string,
    relatedToPersonIds: string[],
    conversationEventId?: string,
    createdBy?: string,
    extractionVersion?: string,
  ): Promise<Person> {
    const existing = await this.findPlaceholderByDescription(
      familyId,
      description,
    );

    if (existing) {
      return existing;
    }

    return await this.createPlaceholder(
      familyId,
      description,
      relatedToPersonIds,
      conversationEventId,
      createdBy,
      extractionVersion,
    );
  }

  /**
   * Merge a placeholder person into a real person.
   * Updates all relationships pointing to the placeholder to point to the real person.
   */
  async mergePlaceholderIntoPerson(
    familyId: string,
    placeholderId: string,
    realPersonId: string,
  ): Promise<void> {
    // This will be called by RelationshipRepository or a higher-level service
    // to update relationships when we discover who a placeholder actually is
    const { error } = await this.client
      .from(this.tableName)
      .update({
        redacted: true,
        redacted_at: new Date().toISOString(),
        redacted_by: 'system:merge',
        redaction_reason: `Merged into person ${realPersonId}`,
      })
      .eq('family_id', familyId)
      .eq('id', placeholderId)
      .eq('is_placeholder', true);

    if (error) {
      throw new Error(`Failed to merge placeholder: ${error.message}`);
    }
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
            matrix[i - 1][j] + 1, // deletion
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
