import { Elysia, t } from 'elysia';
import {
  ConversationEventRepository,
  ConversationEventProcessingRepository,
  ProcessingQueueRepository,
  ClaimAnalysisRepository,
  mapRowToCamelCase,
  type DatabaseClient,
} from '@sobremesa/database';

const MAX_TRACE_EVENTS = 25;

/** Polymorphic `entity_merges` source/target types → the table and display-name column for each. */
const ENTITY_NAME_LOOKUP: Record<
  string,
  { table: string; nameColumn: string }
> = {
  person: { table: 'people', nameColumn: 'name' },
  place: { table: 'places', nameColumn: 'name' },
  event: { table: 'events', nameColumn: 'title' },
  story: { table: 'stories', nameColumn: 'title' },
};

/** Batch-resolves display names for polymorphic entity refs, keyed by `${type}:${id}`. */
async function resolveEntityNames(
  dbClient: DatabaseClient,
  familyId: string,
  refs: Array<{ type: string; id: string }>,
): Promise<Map<string, string>> {
  const idsByType = new Map<string, Set<string>>();
  for (const ref of refs) {
    if (!idsByType.has(ref.type)) idsByType.set(ref.type, new Set());
    idsByType.get(ref.type)?.add(ref.id);
  }

  const nameByRef = new Map<string, string>();
  await Promise.all(
    [...idsByType.entries()].map(async ([type, ids]) => {
      const meta = ENTITY_NAME_LOOKUP[type];
      if (!meta || ids.size === 0) return;
      const { data, error } = await dbClient
        .from(meta.table)
        .select(`id, ${meta.nameColumn}`)
        .eq('family_id', familyId)
        .in('id', [...ids]);
      if (error) {
        throw new Error(`Failed to resolve ${type} names: ${error.message}`);
      }
      for (const row of (data ?? []) as unknown as Array<
        Record<string, unknown>
      >) {
        const name = row[meta.nameColumn];
        if (typeof name === 'string') {
          nameByRef.set(`${type}:${row['id']}`, name);
        }
      }
    }),
  );
  return nameByRef;
}

/**
 * Traces one or more real messages through the already-persisted pipeline:
 * ingestion, queue status, Intern/Scribe preprocessing artifacts, the
 * `event_log` audit trail (routing decision, filter/extraction/persist
 * steps, errors), and everything canonical that traces back to it via
 * provenance columns (`claims.conversation_event_id`,
 * `relationships.conversation_event_id`, `people`/`places
 * .first_mentioned_event_id`). Read-only — writes nothing.
 *
 * Deliberately raw `dbClient` queries for the provenance lookups below
 * (`event_log`, `claims`, `relationships`, `people`, `places`): none of
 * those repositories has a "find by this event id" method today, and adding
 * one to shared production repositories for a debug-only view isn't
 * warranted — same call the `apps/api/src/routes/family.ts` summary route
 * already makes for its own read-only aggregation.
 */
export function traceRoutes(dbClient: DatabaseClient) {
  const eventRepo = new ConversationEventRepository(dbClient);
  const queueRepo = new ProcessingQueueRepository(dbClient);
  const processingRepo = new ConversationEventProcessingRepository(dbClient);
  const claimAnalysisRepo = new ClaimAnalysisRepository(dbClient);

  return new Elysia().get(
    '/api/families/:id/trace',
    async ({ params: { id: familyId }, query, set }) => {
      const eventIds = query.eventIds
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);

      if (eventIds.length === 0) {
        set.status = 400;
        return { error: 'eventIds must contain at least one id' };
      }
      if (eventIds.length > MAX_TRACE_EVENTS) {
        set.status = 400;
        return { error: `eventIds is capped at ${MAX_TRACE_EVENTS}` };
      }

      try {
        const traces = await Promise.all(
          eventIds.map((eventId) =>
            buildEventTrace(
              dbClient,
              eventRepo,
              queueRepo,
              processingRepo,
              claimAnalysisRepo,
              familyId,
              eventId,
            ),
          ),
        );
        const found = traces.filter(
          (trace): trace is NonNullable<typeof trace> => trace !== null,
        );
        found.sort(
          (a, b) =>
            (a.event.sequenceNumber ?? 0) - (b.event.sequenceNumber ?? 0),
        );
        return found;
      } catch (err) {
        set.status = 500;
        return {
          error: err instanceof Error ? err.message : 'Failed to build trace',
        };
      }
    },
    {
      params: t.Object({ id: t.String() }),
      query: t.Object({ eventIds: t.String() }),
    },
  );
}

async function buildEventTrace(
  dbClient: DatabaseClient,
  eventRepo: ConversationEventRepository,
  queueRepo: ProcessingQueueRepository,
  processingRepo: ConversationEventProcessingRepository,
  claimAnalysisRepo: ClaimAnalysisRepository,
  familyId: string,
  eventId: string,
) {
  const event = await eventRepo.findById(familyId, eventId);
  if (!event) return null;

  const [
    queue,
    processing,
    eventLogRes,
    claimsRes,
    relationshipsRes,
    peopleRes,
    placesRes,
    redactionRes,
    internDecisionRes,
  ] = await Promise.all([
    queueRepo.findByEventId(familyId, eventId),
    processingRepo.findByEventId(familyId, eventId),
    dbClient
      .from('event_log')
      .select(
        'id, created_at, event_type, event_category, actor, actor_type, event_data, severity',
      )
      .eq('family_id', familyId)
      .eq('conversation_event_id', eventId)
      .order('created_at', { ascending: true }),
    dbClient
      .from('claims')
      .select(
        'id, claim_type, subject, claim_value, claimed_by, claimed_by_source, attributed_to, confidence, status, claimed_at',
      )
      .eq('family_id', familyId)
      .eq('conversation_event_id', eventId),
    // No `person_a:person_a_id(name)` embed here: relationships' FKs to
    // `people` are composite (`family_id, person_a_id`), and PostgREST's
    // automatic embed shorthand only infers single-column FKs — the exact
    // same shorthand in `apps/api/src/routes/family.ts`'s summary route is
    // silently broken in production for the same reason. Names are resolved
    // separately below instead.
    dbClient
      .from('relationships')
      .select('id, relationship_type, category, person_a_id, person_b_id')
      .eq('family_id', familyId)
      .eq('conversation_event_id', eventId),
    dbClient
      .from('people')
      .select('id, name, aliases, is_placeholder, birth_year, death_year')
      .eq('family_id', familyId)
      .eq('first_mentioned_event_id', eventId),
    dbClient
      .from('places')
      .select('id, name, type, city, region, country')
      .eq('family_id', familyId)
      .eq('first_mentioned_event_id', eventId),
    dbClient
      .from('conversation_redactions')
      .select('redacted_at, redaction_reason')
      .eq('family_id', familyId)
      .eq('conversation_event_id', eventId)
      .maybeSingle(),
    dbClient
      .from('intern_decisions')
      .select(
        'decision, reason, overridden, original_decision, import_job_id, updated_at',
      )
      .eq('family_id', familyId)
      .eq('conversation_event_id', eventId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  for (const [label, res] of [
    ['event_log', eventLogRes],
    ['claims', claimsRes],
    ['relationships', relationshipsRes],
    ['people', peopleRes],
    ['places', placesRes],
    ['conversation_redactions', redactionRes],
    ['intern_decisions', internDecisionRes],
  ] as const) {
    if (res.error) {
      throw new Error(
        `Failed to load ${label} for ${eventId}: ${res.error.message}`,
      );
    }
  }

  const eventRow = event as unknown as Record<string, unknown>;

  const relationshipRows = (relationshipsRes.data ?? []) as Array<{
    id: string;
    relationship_type: string;
    category: string | null;
    person_a_id: string;
    person_b_id: string;
  }>;
  const personIds = [
    ...new Set(
      relationshipRows.flatMap((row) => [row.person_a_id, row.person_b_id]),
    ),
  ];
  const personNameById = new Map<string, string>();
  if (personIds.length > 0) {
    const { data: relatedPeople, error: relatedPeopleError } = await dbClient
      .from('people')
      .select('id, name')
      .eq('family_id', familyId)
      .in('id', personIds);
    if (relatedPeopleError) {
      throw new Error(
        `Failed to resolve relationship person names for ${eventId}: ${relatedPeopleError.message}`,
      );
    }
    for (const person of relatedPeople ?? []) {
      personNameById.set(person.id, person.name);
    }
  }

  type ClaimRow = {
    id: string;
    claim_type: string;
    subject: string;
    claim_value: unknown;
    claimed_by: string;
    claimed_by_source: string;
    attributed_to: string | null;
    confidence: string;
    status: string;
    claimed_at: string;
  };
  type ClaimSummary = {
    id: string;
    subject: string;
    claim_value: unknown;
    claimed_by: string;
    status: string;
  };
  const claimRows = (claimsRes.data ?? []) as ClaimRow[];
  const claimIds = claimRows.map((row) => row.id);

  const [claimAnalyses, conflictRowsRes, entityMergeRowsRes] =
    await Promise.all([
      claimAnalysisRepo.findByClaimIds(familyId, claimIds),
      claimIds.length > 0
        ? dbClient
            .from('claim_conflicts')
            .select('claim_id, conflicts_with_claim_id')
            .eq('family_id', familyId)
            .or(
              `claim_id.in.(${claimIds.join(',')}),conflicts_with_claim_id.in.(${claimIds.join(',')})`,
            )
        : Promise.resolve({ data: [], error: null }),
      dbClient
        .from('entity_merges')
        .select(
          'id, source_entity_id, source_entity_type, target_entity_id, target_entity_type, merge_strategy, confidence, merged_by, merge_reason',
        )
        .eq('family_id', familyId)
        .eq('trigger_event_id', eventId),
    ]);

  for (const [label, res] of [
    ['claim_conflicts', conflictRowsRes],
    ['entity_merges', entityMergeRowsRes],
  ] as const) {
    if (res.error) {
      throw new Error(
        `Failed to load ${label} for ${eventId}: ${res.error.message}`,
      );
    }
  }

  const conflictRows = (conflictRowsRes.data ?? []) as Array<{
    claim_id: string;
    conflicts_with_claim_id: string;
  }>;
  const claimById = new Map<string, ClaimSummary>(
    claimRows.map((row) => [row.id, row]),
  );
  const otherClaimIds = [
    ...new Set(
      conflictRows
        .flatMap((row) => [row.claim_id, row.conflicts_with_claim_id])
        .filter((id) => !claimById.has(id)),
    ),
  ];
  if (otherClaimIds.length > 0) {
    const { data: otherClaims, error: otherClaimsError } = await dbClient
      .from('claims')
      .select('id, subject, claim_value, claimed_by, status')
      .eq('family_id', familyId)
      .in('id', otherClaimIds);
    if (otherClaimsError) {
      throw new Error(
        `Failed to resolve conflicting claims for ${eventId}: ${otherClaimsError.message}`,
      );
    }
    for (const row of (otherClaims ?? []) as ClaimSummary[]) {
      claimById.set(row.id, row);
    }
  }

  const analysisByClaimId = new Map(claimAnalyses.map((a) => [a.claimId, a]));
  // Registrar writes both directions of a conflict as separate rows
  // (`ClaimRepository.addConflict`), and the `.or()` query above fetches
  // both — so each row is one directed edge, not something to re-symmetrize.
  const conflictsByClaimId = new Map<string, string[]>();
  for (const row of conflictRows) {
    if (!conflictsByClaimId.has(row.claim_id))
      conflictsByClaimId.set(row.claim_id, []);
    conflictsByClaimId.get(row.claim_id)?.push(row.conflicts_with_claim_id);
  }

  const mergeRows = (entityMergeRowsRes.data ?? []) as Array<{
    id: string;
    source_entity_id: string;
    source_entity_type: string;
    target_entity_id: string;
    target_entity_type: string;
    merge_strategy: string | null;
    confidence: number | null;
    merged_by: string | null;
    merge_reason: string | null;
  }>;
  const entityNameByRef = await resolveEntityNames(
    dbClient,
    familyId,
    mergeRows.flatMap((m) => [
      { type: m.source_entity_type, id: m.source_entity_id },
      { type: m.target_entity_type, id: m.target_entity_id },
    ]),
  );

  return {
    event: {
      id: event.id,
      conversationId: event.conversationId,
      sequenceNumber: event.sequenceNumber,
      source: event.source,
      eventType: event.eventType,
      actorDisplayName: event.actorDisplayName,
      actorUsername: event.actorUsername,
      contentOriginal: event.contentOriginal,
      languageOriginal: event.languageOriginal,
      occurredAt: event.occurredAt,
      ingestedAt: event.ingestedAt,
      externalReplyToId: event.externalReplyToId,
      // Not on the `ConversationEvent` type yet, but present on the row —
      // the clearest signal of "imported" vs "live" a trace can show.
      ingestionBatchId: eventRow['ingestionBatchId'] ?? null,
    },
    queue: queue
      ? {
          status: queue.status,
          attempts: queue.attempts,
          lastError: queue.lastError,
          queuedAt: queue.queuedAt,
          lockedAt: queue.lockedAt,
          lockedBy: queue.lockedBy,
          priority: queue.priority,
        }
      : null,
    processing: processing
      ? {
          detectedLanguage: processing.detectedLanguage,
          imageReferences: processing.imageReferences,
          processingMetadata: processing.processingMetadata,
          processedAt: processing.processedAt,
          processedBy: processing.processedBy,
        }
      : null,
    eventLog: (eventLogRes.data ?? []).map((row) => mapRowToCamelCase(row)),
    redaction: redactionRes.data ? mapRowToCamelCase(redactionRes.data) : null,
    intern: internDecisionRes.data
      ? mapRowToCamelCase(internDecisionRes.data)
      : null,
    produced: {
      claims: claimRows.map((row) => {
        const analysis = analysisByClaimId.get(row.id);
        const conflictIds = conflictsByClaimId.get(row.id) ?? [];
        return {
          ...mapRowToCamelCase<Record<string, unknown>>(row),
          analysis: analysis
            ? {
                claimStrength: analysis.claimStrength ?? null,
                inferenceMethod: analysis.inferenceMethod ?? null,
                grounding:
                  (
                    analysis.strengthFactors as
                      | { grounding?: string }
                      | undefined
                  )?.grounding ?? null,
              }
            : null,
          conflicts: conflictIds.map((otherId) => {
            const other = claimById.get(otherId);
            return {
              claimId: otherId,
              subject: other?.subject ?? null,
              claimValue: other?.claim_value ?? null,
              claimedBy: other?.claimed_by ?? null,
              status: other?.status ?? null,
            };
          }),
        };
      }),
      relationships: relationshipRows.map((row) => ({
        id: row.id,
        relationshipType: row.relationship_type,
        category: row.category,
        personAName: personNameById.get(row.person_a_id) ?? null,
        personBName: personNameById.get(row.person_b_id) ?? null,
      })),
      people: (peopleRes.data ?? []).map((row) => mapRowToCamelCase(row)),
      places: (placesRes.data ?? []).map((row) => mapRowToCamelCase(row)),
      merges: mergeRows.map((row) => ({
        id: row.id,
        sourceEntityType: row.source_entity_type,
        sourceEntityName:
          entityNameByRef.get(
            `${row.source_entity_type}:${row.source_entity_id}`,
          ) ?? null,
        targetEntityType: row.target_entity_type,
        targetEntityName:
          entityNameByRef.get(
            `${row.target_entity_type}:${row.target_entity_id}`,
          ) ?? null,
        mergeStrategy: row.merge_strategy,
        confidence: row.confidence,
        mergedBy: row.merged_by,
        mergeReason: row.merge_reason,
      })),
    },
  };
}
