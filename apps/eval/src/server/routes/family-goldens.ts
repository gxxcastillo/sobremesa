import { Elysia, t } from 'elysia';
import type { DatabaseClient } from '@sobremesa/database';
import type {
  Confidence,
  ExtractedClaim,
  ExtractedPerson,
  ExtractedPlace,
  ExtractedEvent,
  ExtractedRelationship,
  ScribeDomainModel,
} from '@sobremesa/shared-types';
import {
  scoreScenario,
  type GoldenExpectation,
  type ScenarioRunResult,
} from '@sobremesa/evals';
import { resolvePersonNames } from './families';
import type { EvalStore } from '../store';

const SCORING_THRESHOLD = 0.8;
const CONFIDENCE: Confidence = 'medium';

/**
 * Builds synthetic `ScribeDomainModel` "outputs" from a family's
 * already-persisted entities, so the existing scorer (`scoreScenario`, which
 * normally scores a live Scribe run against a golden) can score real,
 * already-extracted data instead — no new LLM call, no new matching logic.
 *
 * One story per output (mirrors a real Scribe run, which emits at most one
 * `story` per message — `aggregateOutputs` inside the scorer flatMaps
 * `story` across outputs) plus one output carrying everything else.
 *
 * Grounding can't be recomputed this way: `ExtractedClaim.evidence` (a
 * verbatim span from the source message) only exists on a live Scribe
 * response, never persisted on the `claims` row. Every claim here has no
 * `evidence`, so `scoreScenario`'s grounding check reports every claim
 * `unmatched` (not `context_bleed`, so nothing gets filtered out) — the
 * caller must not surface that grounding summary as a real verdict.
 */
async function buildFamilyOutputs(
  dbClient: DatabaseClient,
  familyId: string,
): Promise<ScribeDomainModel[]> {
  const [
    peopleRes,
    placesRes,
    relationshipsRes,
    eventsRes,
    claimsRes,
    storiesRes,
  ] = await Promise.all([
    dbClient
      .from('people')
      .select('name, aliases, birth_year, death_year')
      .eq('family_id', familyId),
    dbClient
      .from('places')
      .select('name, type, city, region, country')
      .eq('family_id', familyId),
    dbClient
      .from('relationships')
      .select('person_a_id, person_b_id, relationship_type')
      .eq('family_id', familyId),
    dbClient
      .from('events')
      .select('title, event_type, date_text, date_year')
      .eq('family_id', familyId),
    dbClient
      .from('claims')
      .select(
        'claim_type, subject, claim_value, attributed_to, claimed_by_source',
      )
      .eq('family_id', familyId)
      .eq('status', 'active'),
    dbClient
      .from('stories')
      .select('title, content_original, themes')
      .eq('family_id', familyId),
  ]);

  for (const [label, res] of [
    ['people', peopleRes],
    ['places', placesRes],
    ['relationships', relationshipsRes],
    ['events', eventsRes],
    ['claims', claimsRes],
    ['stories', storiesRes],
  ] as const) {
    if (res.error) {
      throw new Error(
        `Failed to load ${label} for ${familyId}: ${res.error.message}`,
      );
    }
  }

  const relationshipRows = (relationshipsRes.data ?? []) as Array<{
    person_a_id: string;
    person_b_id: string;
    relationship_type: string;
  }>;
  const nameById = await resolvePersonNames(
    dbClient,
    familyId,
    relationshipRows.flatMap((r) => [r.person_a_id, r.person_b_id]),
  );

  const people: ExtractedPerson[] = (
    peopleRes.data as Array<{
      name: string;
      aliases: string[] | null;
      birth_year: number | null;
      death_year: number | null;
    }>
  ).map((p) => ({
    name: p.name,
    aliases: p.aliases ?? [],
    birthYear: p.birth_year ?? undefined,
    deathYear: p.death_year ?? undefined,
    confidence: CONFIDENCE,
  }));

  const places: ExtractedPlace[] = (
    placesRes.data as Array<{
      name: string;
      type: string | null;
      city: string | null;
      region: string | null;
      country: string | null;
    }>
  ).map((p) => ({
    name: p.name,
    type: p.type ?? undefined,
    city: p.city ?? undefined,
    region: p.region ?? undefined,
    country: p.country ?? undefined,
    confidence: CONFIDENCE,
  }));

  const events: ExtractedEvent[] = (
    eventsRes.data as Array<{
      title: string;
      event_type: string | null;
      date_text: string | null;
      date_year: number | null;
    }>
  ).map((e) => ({
    title: e.title,
    eventType: e.event_type ?? undefined,
    dateText: e.date_text ?? undefined,
    dateYear: e.date_year ?? undefined,
    peopleInvolved: [],
    confidence: CONFIDENCE,
  }));

  const relationships: ExtractedRelationship[] = relationshipRows.map((r) => ({
    personAName: nameById.get(r.person_a_id) ?? r.person_a_id,
    personBName: nameById.get(r.person_b_id) ?? r.person_b_id,
    relationshipType: r.relationship_type,
    confidence: CONFIDENCE,
  }));

  const claims: ExtractedClaim[] = (
    claimsRes.data as Array<{
      claim_type: string;
      subject: string;
      claim_value: string | Record<string, unknown>;
      attributed_to: string | null;
      claimed_by_source: ExtractedClaim['claimedBySource'];
    }>
  ).map((c) => ({
    claimType: c.claim_type,
    subject: c.subject,
    claimValue: c.claim_value,
    // No `evidence` — see the docstring above.
    confidence: CONFIDENCE,
    claimedBySource: c.claimed_by_source,
    attributedTo: c.attributed_to ?? undefined,
  }));

  const base: ScribeDomainModel = {
    conversationEventId: 'family-golden',
    familyId,
    processedAt: new Date(),
    people,
    places,
    events,
    relationships,
    claims,
    imageReferences: [],
  };

  const storyOutputs: ScribeDomainModel[] = (
    storiesRes.data as Array<{
      title: string | null;
      content_original: string;
      themes: string[] | null;
    }>
  ).map((s) => ({
    conversationEventId: 'family-golden',
    familyId,
    processedAt: new Date(),
    people: [],
    places: [],
    events: [],
    relationships: [],
    claims: [],
    imageReferences: [],
    story: {
      title: s.title ?? undefined,
      content: s.content_original,
      themes: s.themes ?? [],
    },
  }));

  return [base, ...storyOutputs];
}

export interface FamilyGoldenScore {
  score: number;
  precision: number;
  recall: number;
  passed: boolean;
  categories: ReturnType<typeof scoreScenario>['categories'];
  forbiddenHits: ReturnType<typeof scoreScenario>['forbiddenHits'];
}

/**
 * Family Compare's "build a golden" editor: a hand-curated `GoldenExpectation`
 * for a pair of already-persisted families, scored against each family's
 * real (already-extracted) data directly — see `buildFamilyOutputs` above
 * for why this reuses `scoreScenario` instead of re-running Scribe live.
 */
export function familyGoldenRoutes(dbClient: DatabaseClient, store: EvalStore) {
  return new Elysia()
    .get(
      '/api/family-goldens',
      ({ query }) => {
        const golden = store.getFamilyGolden(query.familyIdA, query.familyIdB);
        // No draft yet is a normal, expected state (first time comparing
        // this pair) — 200 with an empty golden, not a 404.
        if (!golden) return { golden: {}, updatedAt: null };
        return { golden: golden.golden, updatedAt: golden.updatedAt };
      },
      {
        query: t.Object({ familyIdA: t.String(), familyIdB: t.String() }),
      },
    )
    .put(
      '/api/family-goldens',
      ({ body }) => {
        const saved = store.saveFamilyGolden(
          body.familyIdA,
          body.familyIdB,
          body.golden,
        );
        return { golden: saved.golden, updatedAt: saved.updatedAt };
      },
      {
        body: t.Object({
          familyIdA: t.String(),
          familyIdB: t.String(),
          golden: t.Unknown(),
        }),
      },
    )
    .post(
      '/api/families/:id/score-golden',
      async ({
        params: { id },
        body,
        set,
      }): Promise<FamilyGoldenScore | { error: string }> => {
        try {
          const outputs = await buildFamilyOutputs(dbClient, id);
          const run: ScenarioRunResult = {
            scenario: {
              id: `family-golden:${id}`,
              description:
                'Hand-built golden vs. already-persisted family data',
              senders: {},
              messages: [],
              golden: body.golden as GoldenExpectation,
            },
            outputs,
          };
          const result = scoreScenario(run, SCORING_THRESHOLD);
          return {
            score: result.score,
            precision: result.precision,
            recall: result.recall,
            passed: result.passed,
            categories: result.categories,
            forbiddenHits: result.forbiddenHits,
          };
        } catch (err) {
          set.status = 500;
          return {
            error:
              err instanceof Error
                ? err.message
                : 'Failed to score family against golden',
          };
        }
      },
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({ golden: t.Unknown() }),
      },
    );
}
