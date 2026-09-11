import { Elysia, t } from 'elysia';
import {
  FamilyRepository,
  mapRowToCamelCase,
  type DatabaseClient,
} from '@sobremesa/database';
import type { InternEvaluatedEventData } from '@sobremesa/shared-types';

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
 *
 * "Intern activity" below reads the latest `intern_evaluated` `event_log`
 * entry per conversation event -- an observed pipeline result, not a
 * reviewable decision (there is no override mechanism; see
 * `.agents/plans/unified-import-pipeline-plan.md`). A re-run can append a
 * second `intern_evaluated` row for the same event, so rows are folded down
 * to the latest by `created_at` before use.
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
        internEvaluatedRes,
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
          .from('event_log')
          .select('conversation_event_id, event_data, created_at')
          .eq('family_id', candidateFamilyId)
          .eq('event_type', 'intern_evaluated')
          .order('created_at', { ascending: true }),
      ]);

      for (const [label, result] of [
        ['baseline events', baselineEventsRes],
        ['candidate events', candidateEventsRes],
        ['baseline claims', baselineClaimsRes],
        ['candidate claims', candidateClaimsRes],
        ['Intern activity', internEvaluatedRes],
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
      // Ascending order + Map.set() per row means the last write for a given
      // event id -- the most recent intern_evaluated entry -- wins.
      const internByEvent = new Map<string, InternEvaluatedEventData>();
      for (const row of internEvaluatedRes.data ?? []) {
        if (!row.conversation_event_id) continue;
        internByEvent.set(
          row.conversation_event_id,
          row.event_data as InternEvaluatedEventData,
        );
      }

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

      const internActivity = [...internByEvent.values()];
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
          relevant: internActivity.filter((data) => data.relevant === true)
            .length,
          notRelevant: internActivity.filter((data) => data.relevant === false)
            .length,
          admin: internActivity.filter((data) => data.relevant === null).length,
          missing: candidateEvents.length - internByEvent.size,
        },
        rows: baselineEvents
          .filter((event) => (baselineClaimsByEvent.get(event.id) ?? 0) > 0)
          .map((baselineEvent) => {
            const candidateEvent = candidateBySequence.get(
              baselineEvent.sequence_number,
            );
            const intern = candidateEvent
              ? internByEvent.get(candidateEvent.id)
              : undefined;
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
              intern: intern
                ? {
                    action: intern.action,
                    relevant: intern.relevant,
                    reason: intern.reason,
                    method: intern.method,
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
