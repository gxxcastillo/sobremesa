import { Elysia, t } from 'elysia';
import {
  FamilyRepository,
  mapRowToCamelCase,
  type DatabaseClient,
} from '@sobremesa/database';

type EventRow = {
  id: string;
  conversation_id: string;
  sequence_number: number;
  actor_display_name: string | null;
  actor_username: string | null;
  content_original: string | null;
  occurred_at: string;
  event_type: string;
};

/**
 * Read-only before/after report for a re-import. It intentionally derives
 * its review rows from baseline events that produced active claims, rather
 * than embedding any private known-bad message text in source code.
 */
export function importVerificationRoutes(dbClient: DatabaseClient) {
  const familyRepo = new FamilyRepository(dbClient);

  return new Elysia().get(
    '/api/import-verification',
    async ({ query, set }) => {
      const { baselineFamilyId, candidateFamilyId } = query;
      if (baselineFamilyId === candidateFamilyId) {
        set.status = 400;
        return { error: 'Choose two different families.' };
      }

      const [baseline, candidate] = await Promise.all([
        familyRepo.findById(baselineFamilyId),
        familyRepo.findById(candidateFamilyId),
      ]);
      if (!baseline || !candidate) {
        set.status = 404;
        return { error: 'One or both families were not found.' };
      }

      const [
        baselineEventsRes,
        candidateEventsRes,
        baselineClaimsRes,
        candidateClaimsRes,
        decisionsRes,
      ] = await Promise.all([
        dbClient
          .from('conversation_events')
          .select(
            'id, conversation_id, sequence_number, actor_display_name, actor_username, content_original, occurred_at, event_type',
          )
          .eq('family_id', baselineFamilyId)
          .order('sequence_number', { ascending: true }),
        dbClient
          .from('conversation_events')
          .select(
            'id, conversation_id, sequence_number, actor_display_name, actor_username, content_original, occurred_at, event_type',
          )
          .eq('family_id', candidateFamilyId)
          .order('sequence_number', { ascending: true }),
        dbClient
          .from('claims')
          .select('conversation_event_id')
          .eq('family_id', baselineFamilyId)
          .eq('status', 'active'),
        dbClient
          .from('claims')
          .select('conversation_event_id')
          .eq('family_id', candidateFamilyId)
          .eq('status', 'active'),
        dbClient
          .from('intern_decisions')
          .select('conversation_event_id, decision, reason, overridden')
          .eq('family_id', candidateFamilyId),
      ]);

      for (const [label, result] of [
        ['baseline events', baselineEventsRes],
        ['candidate events', candidateEventsRes],
        ['baseline claims', baselineClaimsRes],
        ['candidate claims', candidateClaimsRes],
        ['Intern decisions', decisionsRes],
      ] as const) {
        if (result.error) {
          set.status = 500;
          return { error: `Could not load ${label}: ${result.error.message}` };
        }
      }

      const baselineEvents = (baselineEventsRes.data ?? []) as EventRow[];
      const candidateEvents = (candidateEventsRes.data ?? []) as EventRow[];
      const candidateBySequence = new Map(
        candidateEvents.map((event) => [event.sequence_number, event]),
      );
      const baselineClaimsByEvent = countByEvent(baselineClaimsRes.data ?? []);
      const candidateClaimsByEvent = countByEvent(
        candidateClaimsRes.data ?? [],
      );
      const decisionByEvent = new Map(
        (decisionsRes.data ?? []).map((decision) => [
          decision.conversation_event_id,
          decision,
        ]),
      );

      let matched = 0;
      let mismatched = 0;
      for (const baselineEvent of baselineEvents) {
        const candidateEvent = candidateBySequence.get(
          baselineEvent.sequence_number,
        );
        if (!candidateEvent) continue;
        if (sameInput(baselineEvent, candidateEvent)) matched++;
        else mismatched++;
      }

      const decisions = [...decisionByEvent.values()];
      return {
        baseline: {
          id: baseline.id,
          name: baseline.name,
          eventCount: baselineEvents.length,
        },
        candidate: {
          id: candidate.id,
          name: candidate.name,
          eventCount: candidateEvents.length,
        },
        input: {
          matched,
          mismatched,
          missing: baselineEvents.length - matched - mismatched,
        },
        intern: {
          process: decisions.filter(
            (decision) => decision.decision === 'process',
          ).length,
          skip: decisions.filter((decision) => decision.decision === 'skip')
            .length,
          missing: candidateEvents.length - decisions.length,
          overridden: decisions.filter((decision) => decision.overridden)
            .length,
        },
        rows: baselineEvents
          .filter((event) => (baselineClaimsByEvent.get(event.id) ?? 0) > 0)
          .map((baselineEvent) => {
            const candidateEvent = candidateBySequence.get(
              baselineEvent.sequence_number,
            );
            const decision = candidateEvent
              ? decisionByEvent.get(candidateEvent.id)
              : null;
            return {
              baselineEvent: mapRowToCamelCase(baselineEvent),
              candidateEvent: candidateEvent
                ? mapRowToCamelCase(candidateEvent)
                : null,
              inputMatches: candidateEvent
                ? sameInput(baselineEvent, candidateEvent)
                : false,
              baselineActiveClaims:
                baselineClaimsByEvent.get(baselineEvent.id) ?? 0,
              candidateActiveClaims: candidateEvent
                ? (candidateClaimsByEvent.get(candidateEvent.id) ?? 0)
                : 0,
              intern: decision
                ? {
                    decision: decision.decision as 'process' | 'skip',
                    reason: decision.reason,
                    overridden: decision.overridden,
                  }
                : null,
            };
          }),
      };
    },
    {
      query: t.Object({
        baselineFamilyId: t.String(),
        candidateFamilyId: t.String(),
      }),
    },
  );
}

function countByEvent(rows: Array<{ conversation_event_id: string | null }>) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.conversation_event_id) continue;
    counts.set(
      row.conversation_event_id,
      (counts.get(row.conversation_event_id) ?? 0) + 1,
    );
  }
  return counts;
}

function sameInput(a: EventRow, b: EventRow): boolean {
  return (
    a.sequence_number === b.sequence_number &&
    a.content_original === b.content_original &&
    a.event_type === b.event_type
  );
}
