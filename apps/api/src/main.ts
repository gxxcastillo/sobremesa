import { Elysia, t } from 'elysia';
import { swagger } from '@elysiajs/swagger';
import { cors } from '@elysiajs/cors';
import {
  FamilyRepository,
  AllowedChatRepository,
  createDatabaseClient,
} from '@sobremesa/database';
import { createAuthPlugin, hasAccessToFamily } from '@sobremesa/auth';
import { authRoutes } from './routes/auth';
import { identityRoutes } from './routes/identity';

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

const app = new Elysia()
  .use(swagger())
  .use(cors())
  .use(authPlugin)
  .use(authRoutes(dbClient))
  .use(identityRoutes(dbClient))
  .get(
    '/health',
    () => ({
      status: 'ok',
      timestamp: new Date().toISOString(),
    }),
    {
      detail: {
        tags: ['Health'],
        description: 'Health check endpoint',
      },
    },
  )
  /**
   * GET /api/public/stats
   * Public aggregate stats (no auth required)
   */
  .get(
    '/api/public/stats',
    async () => {
      // Get aggregate stats across all families
      const [familiesCount, peopleCount, storiesCount, eventsCount] =
        await Promise.all([
          dbClient
            .from('families')
            .select('*', { count: 'exact', head: true })
            .eq('is_active', true),
          dbClient
            .from('people')
            .select('*', { count: 'exact', head: true })
            .eq('redacted', false),
          dbClient
            .from('stories')
            .select('*', { count: 'exact', head: true })
            .eq('redacted', false),
          dbClient
            .from('events')
            .select('*', { count: 'exact', head: true })
            .eq('redacted', false),
        ]);

      return {
        totalFamilies: familiesCount.count || 0,
        totalPeople: peopleCount.count || 0,
        totalStories: storiesCount.count || 0,
        totalEvents: eventsCount.count || 0,
      };
    },
    {
      detail: {
        tags: ['Public'],
        description: 'Get public aggregate statistics',
      },
    },
  )
  /**
   * GET /api/family/summary
   * Get the summary for the active family (first family with chatId)
   * Requires authentication
   */
  .get(
    '/api/family/summary',
    async ({ auth, set }) => {
      if (!auth.isAuthenticated || !auth.identity) {
        set.status = 401;
        return { error: 'Authentication required' };
      }

      const familyRepo = new FamilyRepository(dbClient);

      // Get family
      const families = await familyRepo.findAllActive();
      const family = families.find((f) => f.chatId);

      if (!family) {
        set.status = 404;
        return { error: 'No family with chat ID found' };
      }

      // Check access
      if (!hasAccessToFamily(auth, family.id)) {
        set.status = 403;
        return { error: 'Access denied to this family' };
      }

      // Fetch all data in parallel
      const [
        peopleRes,
        relationshipsRes,
        placesRes,
        eventsRes,
        storiesRes,
        questionsRes,
      ] = await Promise.all([
        dbClient
          .from('people')
          .select('name, aliases, birth_year, death_year, notes_original')
          .eq('family_id', family.id)
          .eq('redacted', false)
          .or('is_placeholder.is.null,is_placeholder.eq.false')
          .order('created_at', { ascending: true }),

        dbClient
          .from('relationships')
          .select(
            `
          relationship_type,
          person_a:person_a_id(name),
          person_b:person_b_id(name)
        `,
          )
          .eq('family_id', family.id),

        dbClient
          .from('places')
          .select('name, type, city, region, country, context_original')
          .eq('family_id', family.id)
          .eq('redacted', false)
          .order('created_at', { ascending: true }),

        dbClient
          .from('events')
          .select(
            'title, event_type, date_text, date_year, description_original',
          )
          .eq('family_id', family.id)
          .eq('redacted', false)
          .order('date_year', { ascending: true, nullsFirst: false }),

        dbClient
          .from('stories')
          .select('title, content_original, themes, completeness')
          .eq('family_id', family.id)
          .eq('redacted', false)
          .order('created_at', { ascending: false }),

        dbClient.from('questions').select('status').eq('family_id', family.id),
      ]);

      const people = peopleRes.data || [];
      const relationships = relationshipsRes.data || [];
      const places = placesRes.data || [];
      const events = eventsRes.data || [];
      const stories = storiesRes.data || [];
      const questionStats = questionsRes.data || [];

      const proposed = questionStats.filter(
        (q) => q.status === 'proposed',
      ).length;
      const asked = questionStats.filter((q) => q.status === 'asked').length;
      const answered = questionStats.filter(
        (q) => q.status === 'answered',
      ).length;

      return {
        familyId: family.id,
        familyName: family.name,
        people,
        relationships,
        places,
        events,
        stories,
        questions: { proposed, asked, answered },
      };
    },
    {
      detail: {
        tags: ['Family'],
        description:
          'Get the summary for the active family (first family with chatId)',
      },
    },
  )
  /**
   * GET /api/family/:familyId/summary
   * Get the summary for a specific family
   * Requires authentication and family membership
   */
  .get(
    '/api/family/:familyId/summary',
    async ({ params: { familyId }, auth, set }) => {
      if (!auth.isAuthenticated || !auth.identity) {
        set.status = 401;
        return { error: 'Authentication required' };
      }

      // Check access
      if (!hasAccessToFamily(auth, familyId)) {
        set.status = 403;
        return { error: 'Access denied to this family' };
      }

      // Fetch all data in parallel
      const [
        peopleRes,
        relationshipsRes,
        placesRes,
        eventsRes,
        storiesRes,
        questionsRes,
        familyRes,
      ] = await Promise.all([
        dbClient
          .from('people')
          .select('name, aliases, birth_year, death_year, notes_original')
          .eq('family_id', familyId)
          .eq('redacted', false)
          .or('is_placeholder.is.null,is_placeholder.eq.false')
          .order('created_at', { ascending: true }),

        dbClient
          .from('relationships')
          .select(
            `
          relationship_type,
          person_a:person_a_id(name),
          person_b:person_b_id(name)
        `,
          )
          .eq('family_id', familyId),

        dbClient
          .from('places')
          .select('name, type, city, region, country, context_original')
          .eq('family_id', familyId)
          .eq('redacted', false)
          .order('created_at', { ascending: true }),

        dbClient
          .from('events')
          .select(
            'title, event_type, date_text, date_year, description_original',
          )
          .eq('family_id', familyId)
          .eq('redacted', false)
          .order('date_year', { ascending: true, nullsFirst: false }),

        dbClient
          .from('stories')
          .select('title, content_original, themes, completeness')
          .eq('family_id', familyId)
          .eq('redacted', false)
          .order('created_at', { ascending: false }),

        dbClient.from('questions').select('status').eq('family_id', familyId),

        dbClient.from('families').select('name').eq('id', familyId).single(),
      ]);

      if (!familyRes.data) {
        set.status = 404;
        return { error: 'Family not found' };
      }

      const people = peopleRes.data || [];
      const relationships = relationshipsRes.data || [];
      const places = placesRes.data || [];
      const events = eventsRes.data || [];
      const stories = storiesRes.data || [];
      const questionStats = questionsRes.data || [];

      const proposed = questionStats.filter(
        (q) => q.status === 'proposed',
      ).length;
      const asked = questionStats.filter((q) => q.status === 'asked').length;
      const answered = questionStats.filter(
        (q) => q.status === 'answered',
      ).length;

      return {
        familyId,
        familyName: familyRes.data.name,
        people,
        relationships,
        places,
        events,
        stories,
        questions: { proposed, asked, answered },
      };
    },
    {
      params: t.Object({ familyId: t.String() }),
      detail: {
        tags: ['Family'],
        description: 'Get the summary for a specific family',
      },
    },
  )
  /**
   * POST /api/narrative/generate
   * Generate a narrative for a family
   * Requires authentication and family membership
   */
  .post(
    '/api/narrative/generate',
    async ({ body, auth, set }) => {
      if (!auth.isAuthenticated || !auth.identity) {
        set.status = 401;
        return { error: 'Authentication required' };
      }

      const { familyId, audience = 'general' } = body;

      // Check access
      if (!hasAccessToFamily(auth, familyId)) {
        set.status = 403;
        return { error: 'Access denied to this family' };
      }

      // TODO: Implement narrative generation logic
      // For now, return a stub response
      return {
        narrative: `This is a generated narrative for family ${familyId} with audience: ${audience}. Implementation coming soon.`,
        audience,
        familyId,
      };
    },
    {
      body: t.Object({
        familyId: t.String(),
        audience: t.Optional(t.String({ default: 'general' })),
      }),
      detail: {
        tags: ['Narrative'],
        description: 'Generate a narrative for a family',
      },
    },
  )
  /**
   * POST /api/book/generate
   * Generate a book for a family
   * Requires authentication and family membership
   */
  .post(
    '/api/book/generate',
    async ({ body, auth, set }) => {
      if (!auth.isAuthenticated || !auth.identity) {
        set.status = 401;
        return { error: 'Authentication required' };
      }

      const { familyId, audience = 'general' } = body;

      // Check access
      if (!hasAccessToFamily(auth, familyId)) {
        set.status = 403;
        return { error: 'Access denied to this family' };
      }

      // TODO: Implement book generation logic
      // For now, return a stub response
      return {
        message: `Book generation started for family ${familyId} with audience: ${audience}`,
        audience,
        familyId,
        status: 'queued',
      };
    },
    {
      body: t.Object({
        familyId: t.String(),
        audience: t.Optional(t.String({ default: 'general' })),
      }),
      detail: {
        tags: ['Book'],
        description: 'Generate a book for a family',
      },
    },
  )
  /**
   * GET /api/admin/chats
   * List all allowed chats
   * Requires super admin
   */
  .get(
    '/api/admin/chats',
    async ({ auth, set }) => {
      if (!auth.isAuthenticated || !auth.identity) {
        set.status = 401;
        return { error: 'Authentication required' };
      }

      if (!auth.isSuperAdmin) {
        set.status = 403;
        return { error: 'Super admin access required' };
      }

      const allowedChatRepo = new AllowedChatRepository(dbClient);
      return allowedChatRepo.list();
    },
    {
      detail: {
        tags: ['Admin'],
        description: 'List all allowed chat IDs (super admin only)',
      },
    },
  )
  /**
   * POST /api/admin/chats
   * Authorize a chat ID
   * Requires super admin
   */
  .post(
    '/api/admin/chats',
    async ({ body, auth, set }) => {
      if (!auth.isAuthenticated || !auth.identity) {
        set.status = 401;
        return { error: 'Authentication required' };
      }

      if (!auth.isSuperAdmin) {
        set.status = 403;
        return { error: 'Super admin access required' };
      }

      const { chatId, note } = body;
      const allowedChatRepo = new AllowedChatRepository(dbClient);
      await allowedChatRepo.add(chatId, note);
      return { success: true };
    },
    {
      body: t.Object({
        chatId: t.String(),
        note: t.Optional(t.String()),
      }),
      detail: {
        tags: ['Admin'],
        description: 'Authorize a chat ID (super admin only)',
      },
    },
  )
  /**
   * DELETE /api/admin/chats/:chatId
   * Remove a chat ID from the allowlist
   * Requires super admin
   */
  .delete(
    '/api/admin/chats/:chatId',
    async ({ params: { chatId }, auth, set }) => {
      if (!auth.isAuthenticated || !auth.identity) {
        set.status = 401;
        return { error: 'Authentication required' };
      }

      if (!auth.isSuperAdmin) {
        set.status = 403;
        return { error: 'Super admin access required' };
      }

      const allowedChatRepo = new AllowedChatRepository(dbClient);
      await allowedChatRepo.remove(chatId);
      return { success: true };
    },
    {
      params: t.Object({ chatId: t.String() }),
      detail: {
        tags: ['Admin'],
        description: 'Remove a chat ID from the allowlist (super admin only)',
      },
    },
  )
  // Error handling
  .onError(({ code, error, set }) => {
    // Let Elysia handle expected errors (404, validation, etc.)
    if (code === 'NOT_FOUND' || code === 'VALIDATION' || code === 'PARSE') {
      return;
    }

    // Log unexpected errors
    console.error('Unhandled error:', error);
    set.status = 500;
    return { error: 'Internal server error' };
  });

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
