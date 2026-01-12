import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getServiceClient } from './client.js';

/**
 * Initialize the database schema.
 * Reads SCHEMA.sql and executes it against Supabase.
 */
export async function initDb(): Promise<void> {
  const client = getServiceClient();

  // Find schema file relative to project root
  const possiblePaths = [
    join(process.cwd(), '.claude/SCHEMA.sql'),
    join(process.cwd(), 'apps/db/supabase/migrations/20260112074715_init_schema.sql'),
  ];

  let schemaPath: string | null = null;
  let schemaSql: string | null = null;

  for (const path of possiblePaths) {
    try {
      schemaSql = readFileSync(path, 'utf-8');
      schemaPath = path;
      break;
    } catch {
      // Try next path
    }
  }

  if (!schemaSql || !schemaPath) {
    throw new Error(
      'Could not find SCHEMA.sql. Looked in:\n' + possiblePaths.join('\n')
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
    console.warn('Note: exec_sql RPC not available, using alternative method...');

    // For Supabase, we can use the management API or just instruct the user
    throw new Error(
      'Direct SQL execution not supported via Supabase JS client.\n\n' +
      'Please run the schema manually:\n' +
      '1. Go to your Supabase dashboard\n' +
      '2. Open SQL Editor\n' +
      '3. Copy contents of .claude/SCHEMA.sql\n' +
      '4. Run the query\n\n' +
      'Or use the Supabase CLI:\n' +
      '  supabase db push'
    );
  }

  console.log('Database initialized successfully!');
}

/**
 * Check if the database is initialized by checking for required tables.
 */
export async function isDbInitialized(): Promise<boolean> {
  const client = getServiceClient();

  try {
    // Try to query the families table
    const { error } = await client
      .from('families')
      .select('id')
      .limit(1);

    return !error;
  } catch {
    return false;
  }
}

/**
 * Get list of missing tables.
 */
export async function getMissingTables(): Promise<string[]> {
  const client = getServiceClient();
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
