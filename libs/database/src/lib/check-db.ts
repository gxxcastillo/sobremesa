import { getServiceClient } from './client';

/**
 * Check database status and report missing tables.
 */
async function checkDb(): Promise<void> {
  console.log('Checking database connection and schema...\n');

  const client = getServiceClient();

  const requiredTables = [
    'families',
    'family_config',
    'conversation_events',
    'processing_queue',
    'people',
    'identities',
    'relationships',
    'places',
    'events',
    'stories',
    'claims',
    'claim_conflicts',
    'images',
    'questions',
    'facilitator_rules',
    'real_time_levers',
    'facilitator_performance',
    'event_log',
    'integrity_checkpoints',
  ];

  const results: {
    table: string;
    status: 'ok' | 'missing' | 'error';
    error?: string;
  }[] = [];

  for (const table of requiredTables) {
    try {
      const { error } = await client.from(table).select('*').limit(0);
      if (error) {
        if (
          error.message.includes('does not exist') ||
          error.code === '42P01'
        ) {
          results.push({ table, status: 'missing' });
        } else {
          results.push({ table, status: 'error', error: error.message });
        }
      } else {
        results.push({ table, status: 'ok' });
      }
    } catch (err) {
      results.push({
        table,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Report results
  const ok = results.filter((r) => r.status === 'ok');
  const missing = results.filter((r) => r.status === 'missing');
  const errors = results.filter((r) => r.status === 'error');

  console.log('Database Schema Status');
  console.log('======================\n');

  if (ok.length > 0) {
    console.log(`✓ ${ok.length} tables found:`);
    ok.forEach((r) => console.log(`  - ${r.table}`));
    console.log();
  }

  if (missing.length > 0) {
    console.log(`✗ ${missing.length} tables missing:`);
    missing.forEach((r) => console.log(`  - ${r.table}`));
    console.log();
  }

  if (errors.length > 0) {
    console.log(`! ${errors.length} tables with errors:`);
    errors.forEach((r) => console.log(`  - ${r.table}: ${r.error}`));
    console.log();
  }

  // Summary
  if (missing.length === 0 && errors.length === 0) {
    console.log('✓ Database is fully initialized!\n');
  } else {
    console.log('Database needs initialization.\n');
    console.log('To initialize, run the schema in Supabase SQL Editor:');
    console.log('  1. Go to your Supabase project dashboard');
    console.log('  2. Click "SQL Editor" in the left sidebar');
    console.log('  3. Click "New query"');
    console.log('  4. Copy the contents of .claude/SCHEMA.sql');
    console.log('  5. Click "Run"\n');
  }
}

// Run if called directly
checkDb()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Failed to check database:', err.message);
    process.exit(1);
  });
