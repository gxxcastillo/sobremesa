import { Elysia, t } from 'elysia';
import { swagger } from '@elysiajs/swagger';
import { cors } from '@elysiajs/cors';
import {
  FamilyRepository,
  AllowedChatRepository,
  getServiceClient,
} from '@sobremesa/database';

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
    }
  )
  /**
   * GET /api/family/summary
   * Get the summary for the active family (first family with chatId)
   */
  .get(
    '/api/family/summary',
    async () => {
      const client = getServiceClient();
      const familyRepo = new FamilyRepository();

      // Get family
      const families = await familyRepo.findAllActive();
      const family = families.find((f) => f.chatId);

      if (!family) {
        throw new Error('No family with chat ID found');
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
        client
          .from('people')
          .select('name, aliases, birth_year, death_year, notes_original')
          .eq('family_id', family.id)
          .eq('redacted', false)
          .order('created_at', { ascending: true }),

        client
          .from('relationships')
          .select(
            `
          relationship_type,
          person_a:person_a_id(name),
          person_b:person_b_id(name)
        `
          )
          .eq('family_id', family.id),

        client
          .from('places')
          .select('name, type, city, region, country, context_original')
          .eq('family_id', family.id)
          .eq('redacted', false)
          .order('created_at', { ascending: true }),

        client
          .from('events')
          .select(
            'title, event_type, date_year, date_month, description_original'
          )
          .eq('family_id', family.id)
          .eq('redacted', false)
          .order('date_year', { ascending: true, nullsFirst: false }),

        client
          .from('stories')
          .select('title, content_original, themes, completeness')
          .eq('family_id', family.id)
          .eq('redacted', false)
          .order('created_at', { ascending: false }),

        client.from('questions').select('status').eq('family_id', family.id),
      ]);

      const people = peopleRes.data || [];
      const relationships = relationshipsRes.data || [];
      const places = placesRes.data || [];
      const events = eventsRes.data || [];
      const stories = storiesRes.data || [];
      const questionStats = questionsRes.data || [];

      const proposed = questionStats.filter(
        (q) => q.status === 'proposed'
      ).length;
      const asked = questionStats.filter((q) => q.status === 'asked').length;
      const answered = questionStats.filter(
        (q) => q.status === 'answered'
      ).length;

      return {
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
    }
  )
  /**
   * GET /api/family/:familyId/summary
   * Get the summary for a specific family
   */
  .get(
    '/api/family/:familyId/summary',
    async ({ params: { familyId } }) => {
      const client = getServiceClient();

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
        client
          .from('people')
          .select('name, aliases, birth_year, death_year, notes_original')
          .eq('family_id', familyId)
          .eq('redacted', false)
          .order('created_at', { ascending: true }),

        client
          .from('relationships')
          .select(
            `
          relationship_type,
          person_a:person_a_id(name),
          person_b:person_b_id(name)
        `
          )
          .eq('family_id', familyId),

        client
          .from('places')
          .select('name, type, city, region, country, context_original')
          .eq('family_id', familyId)
          .eq('redacted', false)
          .order('created_at', { ascending: true }),

        client
          .from('events')
          .select(
            'title, event_type, date_year, date_month, description_original'
          )
          .eq('family_id', familyId)
          .eq('redacted', false)
          .order('date_year', { ascending: true, nullsFirst: false }),

        client
          .from('stories')
          .select('title, content_original, themes, completeness')
          .eq('family_id', familyId)
          .eq('redacted', false)
          .order('created_at', { ascending: false }),

        client.from('questions').select('status').eq('family_id', familyId),

        client.from('families').select('name').eq('id', familyId).single(),
      ]);

      if (!familyRes.data) {
        throw new Error('Family not found');
      }

      const people = peopleRes.data || [];
      const relationships = relationshipsRes.data || [];
      const places = placesRes.data || [];
      const events = eventsRes.data || [];
      const stories = storiesRes.data || [];
      const questionStats = questionsRes.data || [];

      const proposed = questionStats.filter(
        (q) => q.status === 'proposed'
      ).length;
      const asked = questionStats.filter((q) => q.status === 'asked').length;
      const answered = questionStats.filter(
        (q) => q.status === 'answered'
      ).length;

      return {
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
    }
  )
  /**
   * POST /api/narrative/generate
   * Generate a narrative for a family
   */
  .post(
    '/api/narrative/generate',
    async ({ body }) => {
      const { familyId, audience = 'general' } = body;

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
    }
  )
  /**
   * POST /api/book/generate
   * Generate a book for a family
   */
  .post(
    '/api/book/generate',
    async ({ body }) => {
      const { familyId, audience = 'general' } = body;

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
    }
  )
  /**
   * GET /api/admin/chats
   * List all allowed chats
   */
  .get(
    '/api/admin/chats',
    async () => {
      const allowedChatRepo = new AllowedChatRepository();
      return allowedChatRepo.list();
    },
    {
      detail: {
        tags: ['Admin'],
        description: 'List all allowed chat IDs',
      },
    }
  )
  /**
   * POST /api/admin/chats
   * Authorize a chat ID
   */
  .post(
    '/api/admin/chats',
    async ({ body }) => {
      const { chatId, note } = body;
      const allowedChatRepo = new AllowedChatRepository();
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
        description: 'Authorize a chat ID',
      },
    }
  )
  /**
   * DELETE /api/admin/chats/:chatId
   * Remove a chat ID from the whitelist
   */
  .delete(
    '/api/admin/chats/:chatId',
    async ({ params: { chatId } }) => {
      const allowedChatRepo = new AllowedChatRepository();
      await allowedChatRepo.remove(chatId);
      return { success: true };
    },
    {
      params: t.Object({ chatId: t.String() }),
      detail: {
        tags: ['Admin'],
        description: 'Remove a chat ID from the whitelist',
      },
    }
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
    `📚 Studio API server running on ${protocol}://${hostLabel}:${port}`
  );
  console.log(`   Health check: ${protocol}://${hostLabel}:${port}/health`);
  console.log(`   Swagger docs: ${protocol}://${hostLabel}:${port}/swagger`);
});
