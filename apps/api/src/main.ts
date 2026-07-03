import { createDatabaseClient } from '@sobremesa/database';
import { createAuthPlugin } from '@sobremesa/auth';
import { createApp } from './app';

/**
 * Validate required environment variables on startup
 */
function validateEnv(): void {
  const missing: string[] = [];

  if (!process.env['SUPABASE_URL']) missing.push('SUPABASE_URL');
  if (!process.env['SUPABASE_ANON_KEY']) missing.push('SUPABASE_ANON_KEY');
  if (!process.env['SUPABASE_SERVICE_ROLE_KEY'])
    missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!process.env['ACCESS_PASS_SECRET']) missing.push('ACCESS_PASS_SECRET');
  if (!process.env['TELEGRAM_BOT_TOKEN']) missing.push('TELEGRAM_BOT_TOKEN');

  if (missing.length > 0) {
    console.error(
      '❌ Missing required environment variables:',
      missing.join(', '),
    );
    process.exit(1);
  }
}

// Validate environment variables before starting
validateEnv();

// Initialize database client
const dbClient = createDatabaseClient({
  url: process.env.SUPABASE_URL as string,
  anonKey: process.env.SUPABASE_ANON_KEY as string,
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY as string,
});

// Initialize auth plugin with config
const authPlugin = createAuthPlugin({
  secret: process.env.ACCESS_PASS_SECRET as string,
  dbClient,
});

const port = parseInt(process.env.PORT || '3001', 10);
const hostname = process.env.HOST || '0.0.0.0';
const tlsCertPath = process.env.TLS_CERT;
const tlsKeyPath = process.env.TLS_KEY;
const tlsConfig =
  tlsCertPath && tlsKeyPath
    ? { cert: Bun.file(tlsCertPath), key: Bun.file(tlsKeyPath) }
    : undefined;

const app = createApp({ dbClient, authPlugin });

// Start server
app.listen({ port, hostname, tls: tlsConfig }, () => {
  const protocol = tlsConfig ? 'https' : 'http';
  const hostLabel = hostname === '0.0.0.0' ? 'localhost' : hostname;
  console.log(
    `📚 Studio API server running on ${protocol}://${hostLabel}:${port}`,
  );
  console.log(`   Health check: ${protocol}://${hostLabel}:${port}/health`);
  console.log(`   Swagger docs: ${protocol}://${hostLabel}:${port}/swagger`);
});
