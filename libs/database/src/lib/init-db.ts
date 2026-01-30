import { readFileSync } from 'fs';
import { join } from 'path';
import { createDatabaseClient, type DatabaseClient } from './client';

/**
 * Create database client from environment variables.
 * Used by CLI tools.
 */
function createClientFromEnv(): DatabaseClient {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!url) {
    throw new Error('Missing required environment variable: SUPABASE_URL');
  }

  if (!serviceRoleKey && !anonKey) {
    throw new Error(
      'Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY',
    );
  }

  return createDatabaseClient({
    url,
    anonKey: anonKey || '',
    serviceRoleKey,
  });
}

/**
 * Initialize the database schema.
 * Reads the migration file and executes it against Supabase.
 */
export async function initDb(dbClient?: DatabaseClient): Promise<void> {
  const client = dbClient || createClientFromEnv();

  // Find schema file relative to project root
  const schemaPath = join(
    process.cwd(),
    'apps/db/supabase/migrations/20260112074715_init_schema.sql',
  );

  let schemaSql: string;
  try {
    schemaSql = readFileSync(schemaPath, 'utf-8');
  } catch {
    throw new Error(
      `Could not find schema at: ${schemaPath}\n\n` +
        'Please ensure you are running from the workspace root.',
    );
  }

  console.log(`Found schema at: ${schemaPath}`);
  console.log('Initializing database...');

  // Execute the schema SQL
  const { error } = await client.rpc('exec_sql', { sql: schemaSql });

  if (error) {
    // If the RPC doesn't exist, fall back to running statements individually
    // This is a limitation - Supabase JS client doesn't support raw SQL execution
    // We need to use the REST API or pg directly
    console.warn(
      'Note: exec_sql RPC not available, using alternative method...',
    );

    // For Supabase, we can use the management API or just instruct the user
    throw new Error(
      'Direct SQL execution not supported via Supabase JS client.\n\n' +
        'Please run the schema manually:\n' +
        '1. Go to your Supabase dashboard\n' +
        '2. Open SQL Editor\n' +
        '3. Copy contents of apps/db/supabase/migrations/20260112074715_init_schema.sql\n' +
        '4. Run the query\n\n' +
        'Or use the Supabase CLI:\n' +
        '  supabase db push',
    );
  }

  console.log('Database initialized successfully!');
}

/**
 * Check if the database is initialized by checking for required tables.
 */
export async function isDbInitialized(
  dbClient?: DatabaseClient,
): Promise<boolean> {
  const client = dbClient || createClientFromEnv();

  try {
    // Try to query the families table
    const { error } = await client.from('families').select('id').limit(1);

    return !error;
  } catch {
    return false;
  }
}

/**
 * Get list of missing tables.
 */
export async function getMissingTables(
  dbClient?: DatabaseClient,
): Promise<string[]> {
  const client = dbClient || createClientFromEnv();
  const requiredTables = [
    'families',
    'conversation_events',
    'processing_queue',
    'people',
    'places',
    'events',
    'stories',
    'claims',
    'questions',
    'event_log',
  ];

  const missing: string[] = [];

  for (const table of requiredTables) {
    try {
      const { error } = await client.from(table).select('*').limit(0);
      if (error) {
        missing.push(table);
      }
    } catch {
      missing.push(table);
    }
  }

  return missing;
}

// CLI entry point
if (process.argv[1]?.includes('init-db')) {
  initDb()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
