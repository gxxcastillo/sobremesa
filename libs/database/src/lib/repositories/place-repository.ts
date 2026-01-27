import { SupabaseClient } from '@supabase/supabase-js';
import type { Place, ExtractedPlace } from '@sobremesa/shared-types';
import {
  BaseRepository,
  mapRowToCamelCase,
  mapRecordToSnakeCase,
} from '../base-repository.js';

/**
 * Repository for geographic locations mentioned in stories.
 */
export class PlaceRepository extends BaseRepository<Place> {
  constructor(client?: SupabaseClient) {
    super('places', client);
  }

  /**
   * Find a place by exact name match.
   */
  async findByName(familyId: string, name: string): Promise<Place | null> {
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
      throw new Error(`Failed to find place by name: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Find a place by location hierarchy.
   */
  async findByLocation(
    familyId: string,
    location: { city?: string; region?: string; country?: string },
  ): Promise<Place | null> {
    let query = this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('redacted', false);

    if (location.city) {
      query = query.ilike('city', location.city);
    }
    if (location.region) {
      query = query.ilike('region', location.region);
    }
    if (location.country) {
      query = query.ilike('country', location.country);
    }

    const { data, error } = await query.limit(1).single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      throw new Error(`Failed to find place by location: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Find or create a place.
   */
  async findOrCreate(
    familyId: string,
    extracted: ExtractedPlace,
    conversationEventId: string,
  ): Promise<Place> {
    // Try to find by exact name first
    const existing = await this.findByName(familyId, extracted.name);

    if (existing) {
      return existing;
    }

    // Try to find by location hierarchy
    if (extracted.city || extracted.region || extracted.country) {
      const byLocation = await this.findByLocation(familyId, {
        city: extracted.city,
        region: extracted.region,
        country: extracted.country,
      });

      if (byLocation) {
        return byLocation;
      }
    }

    // Create new place
    const record: Omit<Place, 'id' | 'createdAt' | 'updatedAt'> = {
      familyId,
      name: extracted.name,
      type: extracted.type,
      city: extracted.city,
      region: extracted.region,
      country: extracted.country,
      firstMentionedEventId: conversationEventId,
      redacted: false,
    };

    return await this.insert(record);
  }

  /**
   * Find all places for a family.
   */
  async findAllActive(familyId: string): Promise<Place[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('redacted', false)
      .order('name', { ascending: true });

    if (error) {
      throw new Error(`Failed to find places: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Find places by country.
   */
  async findByCountry(familyId: string, country: string): Promise<Place[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('redacted', false)
      .ilike('country', country)
      .order('name', { ascending: true });

    if (error) {
      throw new Error(`Failed to find places by country: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  protected mapFromDb(row: Record<string, unknown>): Place {
    return mapRowToCamelCase<Place>(row);
  }

  protected mapToDb(record: Place): Record<string, unknown> {
    return mapRecordToSnakeCase(record as unknown as Record<string, unknown>);
  }
}
