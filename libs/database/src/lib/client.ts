import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Database client type.
 * This is currently a Supabase client, but abstracting it allows for
 * easier swapping of database implementations in the future.
 */
export type DatabaseClient = SupabaseClient;

/**
 * Database client configuration.
 */
export interface DatabaseConfig {
  url: string;
  anonKey: string;
  serviceRoleKey?: string;
}

/**
 * Create a new database client with custom configuration.
 * Apps should use this factory to create clients and pass them to repositories.
 */
export function createDatabaseClient(config: DatabaseConfig): DatabaseClient {
  return createClient(config.url, config.serviceRoleKey || config.anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
