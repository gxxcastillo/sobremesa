import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * Database client configuration.
 */
export interface DatabaseConfig {
  url: string;
  anonKey: string;
  serviceRoleKey?: string;
}

/**
 * Get database configuration from environment variables.
 */
export function getDatabaseConfig(): DatabaseConfig {
  const url = process.env['SUPABASE_URL'];
  const anonKey = process.env['SUPABASE_ANON_KEY'];
  const serviceRoleKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];

  if (!url) {
    throw new Error('SUPABASE_URL environment variable is required');
  }

  if (!anonKey) {
    throw new Error('SUPABASE_ANON_KEY environment variable is required');
  }

  return { url, anonKey, serviceRoleKey };
}

let clientInstance: SupabaseClient | null = null;
let serviceClientInstance: SupabaseClient | null = null;

/**
 * Get the Supabase client instance (anon key - respects RLS).
 */
export function getClient(): SupabaseClient {
  if (!clientInstance) {
    const config = getDatabaseConfig();
    clientInstance = createClient(config.url, config.anonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }
  return clientInstance;
}

/**
 * Get the Supabase service client instance (bypasses RLS).
 * Use only for backend operations.
 */
export function getServiceClient(): SupabaseClient {
  if (!serviceClientInstance) {
    const config = getDatabaseConfig();
    if (!config.serviceRoleKey) {
      throw new Error(
        'SUPABASE_SERVICE_ROLE_KEY environment variable is required for service client',
      );
    }
    serviceClientInstance = createClient(config.url, config.serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }
  return serviceClientInstance;
}

/**
 * Create a new Supabase client with custom configuration.
 */
export function createDatabaseClient(config: DatabaseConfig): SupabaseClient {
  return createClient(config.url, config.serviceRoleKey || config.anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

/**
 * Reset client instances (useful for testing).
 */
export function resetClients(): void {
  clientInstance = null;
  serviceClientInstance = null;
}
