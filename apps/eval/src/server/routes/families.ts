import { Elysia, t } from 'elysia';
import {
  FamilyRepository,
  mapRowToCamelCase,
  type DatabaseClient,
} from '@sobremesa/database';
import type { ConversationEvent } from '@sobremesa/shared-types';

const CLAIM_TYPES = [
  'date',
  'location',
  'relationship',
  'detail',
  'identity',
] as const;
const CLAIM_STATUSES = [
  'active',
  'superseded',
  'disputed',
  'redacted',
] as const;

function parseLimit(
  raw: number | undefined,
  fallback: number,
  max: number,
): number {
  return Math.min(Math.max(1, raw ?? fallback), max);
}

/**
 * Batch-resolves person display names for the `relationships` list route.
 * Mirrors `resolveEntityNames`/the inline lookup in `trace.ts`: relationships'
 * FKs to `people` are composite (`family_id, person_a_id`), so PostgREST's
 * automatic embed shorthand can't be used — names are joined in application
 * code instead.
 */
export async function resolvePersonNames(
  dbClient: DatabaseClient,
  familyId: string,
  personIds: string[],
): Promise<Map<string, string>> {
  const nameById = new Map<string, string>();
  const ids = [...new Set(personIds)];
  if (ids.length === 0) return nameById;
  const { data, error } = await dbClient
    .from('people')
    .select('id, name')
    .eq('family_id', familyId)
    .in('id', ids);
  if (error) {
    throw new Error(`Failed to resolve person names: ${error.message}`);
  }
  for (const person of data ?? []) nameById.set(person.id, person.name);
  return nameById;
}

/**
 * Batch-resolves claim summaries (subject/value/status) for the
 * conflict/contradiction list routes, which reference claims that may not
 * be in the primary result set.
 */
export interface ClaimSummary {
  subject: string;
  claimValue: unknown;
  status: string;
  sourceEventId: string | null;
}

export async function resolveClaimSummaries(
  dbClient: DatabaseClient,
  familyId: string,
  claimIds: string[],
): Promise<Map<string, ClaimSummary>> {
  const byId = new Map<string, ClaimSummary>();
  const ids = [...new Set(claimIds)];
  if (ids.length === 0) return byId;
  const { data, error } = await dbClient
    .from('claims')
    .select('id, subject, claim_value, status, conversation_event_id')
    .eq('family_id', familyId)
    .in('id', ids);
  if (error) {
    throw new Error(`Failed to resolve claim summaries: ${error.message}`);
  }
  for (const row of data ?? []) {
    byId.set(row.id, {
      subject: row.subject,
      claimValue: row.claim_value,
      status: row.status,
      sourceEventId: row.conversation_event_id ?? null,
    });
  }
  return byId;
}

/**
 * Read-only family/event browsing so a run can target a real message from an
 * in-progress import. `conversation_events` has no `created_at` column, so
 * listing recent events queries directly rather than through
 * `BaseRepository.findAll` (which hardcodes ordering by `created_at`).
 */
export function familyRoutes(dbClient: DatabaseClient) {
  const familyRepo = new FamilyRepository(dbClient);

  return new Elysia()
    .get('/api/families', async () => {
      const families = await familyRepo.findAllActive();
      return families.map((family) => ({
        id: family.id,
        name: family.name,
        chatId: family.chatId,
      }));
    })
    .get(
      '/api/families/:id/events',
      async ({ params: { id }, query, set }) => {
        const limit = parseLimit(query.limit, 50, 500);
        const offset = Math.max(0, query.offset ?? 0);
        const builder = dbClient
          .from('conversation_events')
          .select(
            'id, conversation_id, sequence_number, actor_display_name, actor_username, content_original, occurred_at, event_type',
          )
          .eq('family_id', id);
        // 'sequence' walks `sequence_number` ascending -- a stable, gapless
        // per-family insertion order (unlike `occurred_at`, which can repeat
        // across messages sent the same minute), so paging through it with
        // `offset` never skips/duplicates rows. Used by Family Compare to
        // page through an entire family's events for an input-match check;
        // 'recent' (default) keeps the original newest-first single-page
        // behavior NewRun/MessageTrace rely on for picking a real message.
        const ordered =
          query.order === 'sequence'
            ? builder.order('sequence_number', { ascending: true })
            : builder.order('occurred_at', { ascending: false });
        const { data, error } = await ordered.range(offset, offset + limit - 1);

        if (error) {
          set.status = 500;
          return { error: `Failed to fetch events: ${error.message}` };
        }

        return (data ?? []).map((row) =>
          mapRowToCamelCase<ConversationEvent>(row),
        );
      },
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({
          limit: t.Optional(t.Numeric()),
          offset: t.Optional(t.Numeric()),
          order: t.Optional(
            t.Union([t.Literal('recent'), t.Literal('sequence')]),
          ),
        }),
      },
    )
    .get(
      '/api/families/:id/stats',
      async ({ params: { id }, set }) => {
        const family = await familyRepo.findById(id);
        if (!family) {
          set.status = 404;
          return { error: `Family not found: ${id}` };
        }

        // Raw `dbClient` counts (no repository method fits — same precedent
        // as `trace.ts`'s provenance lookups): a debug-only aggregate view
        // doesn't warrant new count/group-by methods on shared production
        // repositories.
        const [
          peopleRes,
          placesRes,
          relationshipsRes,
          storiesRes,
          eventsRes,
          claimsActiveRes,
          claimTypeRowsRes,
          claimConflictsRes,
          claimRelationshipsContradictsRes,
        ] = await Promise.all([
          dbClient
            .from('people')
            .select('*', { count: 'exact', head: true })
            .eq('family_id', id),
          dbClient
            .from('places')
            .select('*', { count: 'exact', head: true })
            .eq('family_id', id),
          dbClient
            .from('relationships')
            .select('*', { count: 'exact', head: true })
            .eq('family_id', id),
          dbClient
            .from('stories')
            .select('*', { count: 'exact', head: true })
            .eq('family_id', id),
          dbClient
            .from('events')
            .select('*', { count: 'exact', head: true })
            .eq('family_id', id),
          dbClient
            .from('claims')
            .select('*', { count: 'exact', head: true })
            .eq('family_id', id)
            .eq('status', 'active'),
          dbClient
            .from('claims')
            .select('claim_type')
            .eq('family_id', id)
            .eq('status', 'active'),
          dbClient
            .from('claim_conflicts')
            .select('*', { count: 'exact', head: true })
            .eq('family_id', id),
          dbClient
            .from('claim_relationships')
            .select('*', { count: 'exact', head: true })
            .eq('family_id', id)
            .eq('relationship_type', 'contradicts'),
        ]);

        for (const [label, res] of [
          ['people', peopleRes],
          ['places', placesRes],
          ['relationships', relationshipsRes],
          ['stories', storiesRes],
          ['events', eventsRes],
          ['claimsActive', claimsActiveRes],
          ['claimTypes', claimTypeRowsRes],
          ['claimConflicts', claimConflictsRes],
          ['claimRelationshipsContradicts', claimRelationshipsContradictsRes],
        ] as const) {
          if (res.error) {
            set.status = 500;
            return {
              error: `Failed to load ${label} for ${id}: ${res.error.message}`,
            };
          }
        }

        const claimsByType: Partial<
          Record<(typeof CLAIM_TYPES)[number], number>
        > = {};
        for (const type of CLAIM_TYPES) claimsByType[type] = 0;
        for (const row of (claimTypeRowsRes.data ?? []) as Array<{
          claim_type: string;
        }>) {
          const type = row.claim_type as (typeof CLAIM_TYPES)[number];
          claimsByType[type] = (claimsByType[type] ?? 0) + 1;
        }

        return {
          people: peopleRes.count ?? 0,
          places: placesRes.count ?? 0,
          relationships: relationshipsRes.count ?? 0,
          stories: storiesRes.count ?? 0,
          events: eventsRes.count ?? 0,
          claimsActive: claimsActiveRes.count ?? 0,
          claimsByType,
          claimConflicts: claimConflictsRes.count ?? 0,
          claimRelationshipsContradicts:
            claimRelationshipsContradictsRes.count ?? 0,
        };
      },
      {
        params: t.Object({ id: t.String() }),
      },
    )
    .get(
      '/api/families/:id/meta',
      async ({ params: { id }, set }) => {
        const family = await familyRepo.findById(id);
        if (!family) {
          set.status = 404;
          return { error: `Family not found: ${id}` };
        }

        // `family.config` is untyped storage (`FamilyRepository.create` writes
        // whatever object it's given -- see `ImportProcessor`, which passes
        // `{defaultLanguage, timezone, importSource}` -- so `FamilyConfig`'s
        // declared shape doesn't apply to import-created rows; read loosely.
        const config = (family.config ?? {}) as Record<string, unknown>;

        const [countRes, firstRes, lastRes] = await Promise.all([
          dbClient
            .from('conversation_events')
            .select('*', { count: 'exact', head: true })
            .eq('family_id', id),
          dbClient
            .from('conversation_events')
            .select('occurred_at')
            .eq('family_id', id)
            .order('occurred_at', { ascending: true })
            .limit(1),
          dbClient
            .from('conversation_events')
            .select('occurred_at')
            .eq('family_id', id)
            .order('occurred_at', { ascending: false })
            .limit(1),
        ]);
        for (const [label, res] of [
          ['messageCount', countRes],
          ['firstMessage', firstRes],
          ['lastMessage', lastRes],
        ] as const) {
          if (res.error) {
            set.status = 500;
            return {
              error: `Failed to load ${label} for ${id}: ${res.error.message}`,
            };
          }
        }

        return {
          name: family.name,
          chatSource:
            (family as unknown as { chatSource?: string | null }).chatSource ??
            null,
          chatId: family.chatId ?? null,
          createdAt: family.createdAt,
          defaultLanguage:
            (config['defaultLanguage'] as string | undefined) ?? null,
          timezone: (config['timezone'] as string | undefined) ?? null,
          importSource: (config['importSource'] as string | undefined) ?? null,
          messageCount: countRes.count ?? 0,
          firstMessageAt:
            (firstRes.data?.[0] as { occurred_at?: string } | undefined)
              ?.occurred_at ?? null,
          lastMessageAt:
            (lastRes.data?.[0] as { occurred_at?: string } | undefined)
              ?.occurred_at ?? null,
        };
      },
      {
        params: t.Object({ id: t.String() }),
      },
    )
    .get(
      '/api/families/:id/people',
      async ({ params: { id }, query, set }) => {
        const limit = parseLimit(query.limit, 300, 1000);
        const { data, error } = await dbClient
          .from('people')
          .select(
            'id, name, aliases, is_placeholder, birth_year, death_year, redacted, superseded_by, source_event_id:first_mentioned_event_id',
          )
          .eq('family_id', id)
          .limit(limit);
        if (error) {
          set.status = 500;
          return {
            error: `Failed to fetch people for ${id}: ${error.message}`,
          };
        }
        const rows = (data ?? []).map((row) =>
          mapRowToCamelCase<Record<string, unknown>>(row),
        );
        rows.sort(
          (a, b) =>
            String(a['name']).localeCompare(String(b['name'])) ||
            String(a['id']).localeCompare(String(b['id'])),
        );
        return rows;
      },
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({ limit: t.Optional(t.Numeric()) }),
      },
    )
    .get(
      '/api/families/:id/places',
      async ({ params: { id }, query, set }) => {
        const limit = parseLimit(query.limit, 300, 1000);
        const { data, error } = await dbClient
          .from('places')
          .select(
            'id, name, type, city, region, country, redacted, superseded_by, source_event_id:first_mentioned_event_id',
          )
          .eq('family_id', id)
          .limit(limit);
        if (error) {
          set.status = 500;
          return {
            error: `Failed to fetch places for ${id}: ${error.message}`,
          };
        }
        const rows = (data ?? []).map((row) =>
          mapRowToCamelCase<Record<string, unknown>>(row),
        );
        rows.sort(
          (a, b) =>
            String(a['name']).localeCompare(String(b['name'])) ||
            String(a['id']).localeCompare(String(b['id'])),
        );
        return rows;
      },
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({ limit: t.Optional(t.Numeric()) }),
      },
    )
    .get(
      '/api/families/:id/relationships',
      async ({ params: { id }, query, set }) => {
        const limit = parseLimit(query.limit, 300, 1000);
        const { data, error } = await dbClient
          .from('relationships')
          .select(
            'id, person_a_id, person_b_id, relationship_type, category, status, qualifier, confidence, source_event_id:conversation_event_id',
          )
          .eq('family_id', id)
          .limit(limit);
        if (error) {
          set.status = 500;
          return {
            error: `Failed to fetch relationships for ${id}: ${error.message}`,
          };
        }
        const rows = (data ?? []) as Array<{
          id: string;
          person_a_id: string;
          person_b_id: string;
          relationship_type: string;
          category: string | null;
          status: string | null;
          qualifier: string | null;
          confidence: string | null;
          source_event_id: string | null;
        }>;
        const nameById = await resolvePersonNames(
          dbClient,
          id,
          rows.flatMap((r) => [r.person_a_id, r.person_b_id]),
        );
        const result = rows.map((r) => ({
          id: r.id,
          personAId: r.person_a_id,
          personAName: nameById.get(r.person_a_id) ?? null,
          personBId: r.person_b_id,
          personBName: nameById.get(r.person_b_id) ?? null,
          relationshipType: r.relationship_type,
          category: r.category,
          status: r.status,
          qualifier: r.qualifier,
          confidence: r.confidence,
          sourceEventId: r.source_event_id,
        }));
        result.sort(
          (a, b) =>
            (a.personAName ?? '').localeCompare(b.personAName ?? '') ||
            (a.personBName ?? '').localeCompare(b.personBName ?? '') ||
            a.relationshipType.localeCompare(b.relationshipType) ||
            a.id.localeCompare(b.id),
        );
        return result;
      },
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({ limit: t.Optional(t.Numeric()) }),
      },
    )
    .get(
      '/api/families/:id/stories',
      async ({ params: { id }, query, set }) => {
        const limit = parseLimit(query.limit, 300, 1000);
        const { data, error } = await dbClient
          .from('stories')
          .select(
            'id, title, content_original, themes, timeframe, completeness, confidence, redacted, superseded_by',
          )
          .eq('family_id', id)
          .limit(limit);
        if (error) {
          set.status = 500;
          return {
            error: `Failed to fetch stories for ${id}: ${error.message}`,
          };
        }
        const rows = (data ?? []).map((row) =>
          mapRowToCamelCase<Record<string, unknown>>(row),
        );
        // Stories' provenance is many-to-many (`story_conversation_events`),
        // unlike every other category's single FK column — batch-resolved
        // separately rather than joined inline.
        const storyIds = rows.map((r) => String(r['id']));
        const sourceEventIdsByStory = new Map<string, string[]>();
        if (storyIds.length > 0) {
          const { data: linkRows, error: linkError } = await dbClient
            .from('story_conversation_events')
            .select('story_id, conversation_event_id')
            .eq('family_id', id)
            .in('story_id', storyIds);
          if (linkError) {
            set.status = 500;
            return {
              error: `Failed to fetch story provenance for ${id}: ${linkError.message}`,
            };
          }
          for (const link of (linkRows ?? []) as Array<{
            story_id: string;
            conversation_event_id: string;
          }>) {
            if (!sourceEventIdsByStory.has(link.story_id))
              sourceEventIdsByStory.set(link.story_id, []);
            sourceEventIdsByStory
              .get(link.story_id)
              ?.push(link.conversation_event_id);
          }
        }
        for (const row of rows) {
          row['sourceEventIds'] =
            sourceEventIdsByStory.get(String(row['id'])) ?? [];
        }
        // No reliable structured date on stories (`timeframe` is free text like
        // "summer 1920" or "1980s") — alphabetical by title is the deterministic
        // order, same as people/places. Untitled stories sort after titled ones,
        // keyed by a content snippet so their relative order still stays fixed.
        rows.sort((a, b) => {
          const aTitle = a['title'] as string | null;
          const bTitle = b['title'] as string | null;
          const aRank = aTitle ? 0 : 1;
          const bRank = bTitle ? 0 : 1;
          if (aRank !== bRank) return aRank - bRank;
          const aKey = aTitle ?? String(a['contentOriginal'] ?? '');
          const bKey = bTitle ?? String(b['contentOriginal'] ?? '');
          return (
            aKey.localeCompare(bKey) ||
            String(a['id']).localeCompare(String(b['id']))
          );
        });
        return rows;
      },
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({ limit: t.Optional(t.Numeric()) }),
      },
    )
    .get(
      '/api/families/:id/timeline-events',
      async ({ params: { id }, query, set }) => {
        const limit = parseLimit(query.limit, 300, 1000);
        const { data, error } = await dbClient
          .from('events')
          .select(
            'id, title, event_type, date_text, date_year, description_original, place_id, redacted, superseded_by, source_event_id:conversation_event_id',
          )
          .eq('family_id', id)
          .limit(limit);
        if (error) {
          set.status = 500;
          return {
            error: `Failed to fetch timeline events for ${id}: ${error.message}`,
          };
        }
        const rows = (data ?? []).map((row) =>
          mapRowToCamelCase<Record<string, unknown>>(row),
        );
        // Chronological by the structured `dateYear`; events without a year
        // (only free-text `dateText`, or none at all) sort after dated ones.
        rows.sort((a, b) => {
          const aYear =
            (a['dateYear'] as number | null) ?? Number.POSITIVE_INFINITY;
          const bYear =
            (b['dateYear'] as number | null) ?? Number.POSITIVE_INFINITY;
          if (aYear !== bYear) return aYear - bYear;
          return (
            String(a['title'] ?? '').localeCompare(String(b['title'] ?? '')) ||
            String(a['id']).localeCompare(String(b['id']))
          );
        });
        return rows;
      },
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({ limit: t.Optional(t.Numeric()) }),
      },
    )
    .get(
      '/api/families/:id/claims',
      async ({ params: { id }, query, set }) => {
        const limit = parseLimit(query.limit, 300, 1000);
        let q = dbClient
          .from('claims')
          .select(
            'id, claim_type, subject, claim_value, confidence, status, claimed_by, claimed_by_source, attributed_to, claimed_at, context_original, source_event_id:conversation_event_id',
          )
          .eq('family_id', id);
        if (query.status) q = q.eq('status', query.status);
        if (query.type) q = q.eq('claim_type', query.type);
        const { data, error } = await q.limit(limit);
        if (error) {
          set.status = 500;
          return {
            error: `Failed to fetch claims for ${id}: ${error.message}`,
          };
        }
        const rows = (data ?? []).map((row) =>
          mapRowToCamelCase<Record<string, unknown>>(row),
        );
        // Claims are a provenance ledger — chronological by when they were
        // claimed is the natural, deterministic reading order.
        rows.sort(
          (a, b) =>
            new Date(String(a['claimedAt'])).getTime() -
              new Date(String(b['claimedAt'])).getTime() ||
            String(a['id']).localeCompare(String(b['id'])),
        );
        return rows;
      },
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({
          limit: t.Optional(t.Numeric()),
          status: t.Optional(t.Union(CLAIM_STATUSES.map((s) => t.Literal(s)))),
          type: t.Optional(t.Union(CLAIM_TYPES.map((c) => t.Literal(c)))),
        }),
      },
    )
    .get(
      '/api/families/:id/claim-conflicts',
      async ({ params: { id }, query, set }) => {
        const limit = parseLimit(query.limit, 300, 1000);
        const { data, error } = await dbClient
          .from('claim_conflicts')
          .select('claim_id, conflicts_with_claim_id, created_at')
          .eq('family_id', id)
          .limit(limit);
        if (error) {
          set.status = 500;
          return {
            error: `Failed to fetch claim conflicts for ${id}: ${error.message}`,
          };
        }
        const rows = (data ?? []) as Array<{
          claim_id: string;
          conflicts_with_claim_id: string;
          created_at: string;
        }>;
        const claimById = await resolveClaimSummaries(
          dbClient,
          id,
          rows.flatMap((r) => [r.claim_id, r.conflicts_with_claim_id]),
        );
        const result = rows.map((r) => ({
          claimId: r.claim_id,
          claimSubject: claimById.get(r.claim_id)?.subject ?? null,
          claimValue: claimById.get(r.claim_id)?.claimValue ?? null,
          claimStatus: claimById.get(r.claim_id)?.status ?? null,
          claimSourceEventId: claimById.get(r.claim_id)?.sourceEventId ?? null,
          conflictsWithClaimId: r.conflicts_with_claim_id,
          conflictsWithSubject:
            claimById.get(r.conflicts_with_claim_id)?.subject ?? null,
          conflictsWithValue:
            claimById.get(r.conflicts_with_claim_id)?.claimValue ?? null,
          conflictsWithStatus:
            claimById.get(r.conflicts_with_claim_id)?.status ?? null,
          conflictsWithSourceEventId:
            claimById.get(r.conflicts_with_claim_id)?.sourceEventId ?? null,
          createdAt: r.created_at,
        }));
        // These are pairs, not single entities with a natural name/date of
        // their own — the deterministic order is when the conflict link
        // itself was recorded.
        result.sort(
          (a, b) =>
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
            a.claimId.localeCompare(b.claimId) ||
            a.conflictsWithClaimId.localeCompare(b.conflictsWithClaimId),
        );
        return result;
      },
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({ limit: t.Optional(t.Numeric()) }),
      },
    )
    .get(
      '/api/families/:id/claim-contradictions',
      async ({ params: { id }, query, set }) => {
        const limit = parseLimit(query.limit, 300, 1000);
        const { data, error } = await dbClient
          .from('claim_relationships')
          .select('claim_id, related_claim_id, created_at')
          .eq('family_id', id)
          .eq('relationship_type', 'contradicts')
          .limit(limit);
        if (error) {
          set.status = 500;
          return {
            error: `Failed to fetch claim contradictions for ${id}: ${error.message}`,
          };
        }
        const rows = (data ?? []) as Array<{
          claim_id: string;
          related_claim_id: string;
          created_at: string;
        }>;
        const claimById = await resolveClaimSummaries(
          dbClient,
          id,
          rows.flatMap((r) => [r.claim_id, r.related_claim_id]),
        );
        const result = rows.map((r) => ({
          claimId: r.claim_id,
          claimSubject: claimById.get(r.claim_id)?.subject ?? null,
          claimValue: claimById.get(r.claim_id)?.claimValue ?? null,
          claimStatus: claimById.get(r.claim_id)?.status ?? null,
          claimSourceEventId: claimById.get(r.claim_id)?.sourceEventId ?? null,
          relatedClaimId: r.related_claim_id,
          relatedSubject: claimById.get(r.related_claim_id)?.subject ?? null,
          relatedValue: claimById.get(r.related_claim_id)?.claimValue ?? null,
          relatedStatus: claimById.get(r.related_claim_id)?.status ?? null,
          relatedSourceEventId:
            claimById.get(r.related_claim_id)?.sourceEventId ?? null,
          createdAt: r.created_at,
        }));
        result.sort(
          (a, b) =>
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
            a.claimId.localeCompare(b.claimId) ||
            a.relatedClaimId.localeCompare(b.relatedClaimId),
        );
        return result;
      },
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({ limit: t.Optional(t.Numeric()) }),
      },
    );
}
