import type { DatabaseClient } from '../client';
import type { Family } from '@sobremesa/shared-types';
import { mapRowToCamelCase } from '../base-repository.js';

/**
 * Repository for family spaces.
 */
export class FamilyRepository {
  private client: DatabaseClient;
  private tableName = 'families';

  constructor(client: DatabaseClient) {
    this.client = client;
  }

  /**
   * Find a family by ID.
   */
  async findById(id: string): Promise<Family | null> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      throw new Error(`Failed to find family by id: ${error.message}`);
    }

    return mapRowToCamelCase<Family>(data);
  }

  /**
   * Find the default active family.
   */
  async findDefault(): Promise<Family | null> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: true })
      .limit(1)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      throw new Error(`Failed to find default family: ${error.message}`);
    }

    return mapRowToCamelCase<Family>(data);
  }

  /**
   * Find all active families.
   */
  async findAllActive(): Promise<Family[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error(`Failed to find active families: ${error.message}`);
    }

    return (data || []).map((row) => mapRowToCamelCase<Family>(row));
  }

  /**
   * Create a new family.
   */
  async create(
    name: string,
    config: Record<string, unknown> = {},
  ): Promise<Family> {
    const { data, error } = await this.client
      .from(this.tableName)
      .insert({ name, config })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create family: ${error.message}`);
    }

    return mapRowToCamelCase<Family>(data);
  }

  /**
   * Update family configuration.
   */
  async updateConfig(
    id: string,
    config: Record<string, unknown>,
  ): Promise<Family> {
    const { data, error } = await this.client
      .from(this.tableName)
      .update({ config })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update family config: ${error.message}`);
    }

    return mapRowToCamelCase<Family>(data);
  }

  /**
   * Find a family by chat ID.
   */
  async findByChatId(chatId: string): Promise<Family | null> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('chat_id', chatId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      throw new Error(`Failed to find family by chat ID: ${error.message}`);
    }

    return mapRowToCamelCase<Family>(data);
  }

  /**
   * Link a chat ID to a family.
   */
  async setChatId(id: string, chatId: string): Promise<Family> {
    const { data, error } = await this.client
      .from(this.tableName)
      .update({ chat_id: chatId })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to set chat ID: ${error.message}`);
    }

    return mapRowToCamelCase<Family>(data);
  }

  /**
   * Create a new family with a chat ID.
   */
  async createWithChat(
    name: string,
    chatId: string,
    config: Record<string, unknown> = {},
  ): Promise<Family> {
    const { data, error } = await this.client
      .from(this.tableName)
      .insert({ name, chat_id: chatId, config })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create family: ${error.message}`);
    }

    return mapRowToCamelCase<Family>(data);
  }

  /**
   * Deactivate a family (soft delete).
   */
  async deactivate(id: string): Promise<Family> {
    const { data, error } = await this.client
      .from(this.tableName)
      .update({ is_active: false })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to deactivate family: ${error.message}`);
    }

    return mapRowToCamelCase<Family>(data);
  }

  /**
   * Update a specific field in family configuration using JSON path.
   * Atomic (row-locked jsonb_set in `update_family_config_path`), so
   * concurrent updates to sibling keys don't overwrite each other.
   *
   * @param id - Family ID
   * @param path - JSON path as array (e.g., ['languages', 'primary'])
   * @param value - Value to set
   */
  async updateConfigPath(
    id: string,
    path: string[],
    value: unknown,
  ): Promise<Family> {
    if (path.length === 0) {
      throw new Error('Config path must not be empty');
    }

    const { data, error } = await this.client
      .rpc('update_family_config_path', {
        p_family_id: id,
        p_path: path,
        p_value: value,
      })
      .single<Record<string, unknown>>();

    if (error) {
      throw new Error(`Failed to update family config: ${error.message}`);
    }

    return mapRowToCamelCase<Family>(data);
  }

  /**
   * Get a specific config value by path.
   */
  async getConfigValue(id: string, path: string[]): Promise<unknown> {
    const family = await this.findById(id);
    if (!family) return undefined;

    let current: unknown = family.config;
    for (const key of path) {
      if (current && typeof current === 'object' && key in current) {
        current = (current as Record<string, unknown>)[key];
      } else {
        return undefined;
      }
    }
    return current;
  }
}
