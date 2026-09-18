#!/usr/bin/env bun
/**
 * Live-DB report for agent-hygiene-plan.md item #0 -- the gate on #5b.
 *
 * Answers, for the imported family:
 *   1. Does a genuine conflicting-claim pair exist in the corpus at all?
 *   2. Did the Registrar persist links for them (claim_conflicts and/or
 *      claim_relationships[relationship_type='contradicts']), in which
 *      table, and are they correct?
 *
 * Both tables are written on the same code path (registrar.ts:1526,
 * :1533-1539), so a disagreement between them reflects history (a link
 * created before one of the two tables existed), not current logic.
 * claim_conflicts stores both directions per pair (2 rows); claim_relationships
 * stores one direction (1 row) since registrar.ts only calls .create() once
 * per detected conflict. Pairs below are reported de-duplicated either way.
 *
 * Separately, simulates the crude answer-time detector
 * (historian/retriever.ts:615-641: group active claims by exact `subject`
 * string, flag a subject if JSON.stringify(claimValue) differs across the
 * group) over all of the family's active claims -- the corpus-wide analogue
 * of what any single retrieval draws from. Each flagged group is tagged
 * "formatting-only" when every value in the group collapses to the same
 * canonical form (case/whitespace/number-vs-string normalized) -- a false
 * positive under D7 -- or "possibly-genuine" otherwise. That split is the
 * false-positive-rate proxy families currently experience.
 *
 * Manual-only -- not part of test:all/CI (per AGENTS.md and
 * tests/live-db-test-utils.ts; no live-DB test runs in CI today).
 * Requires `bun nx run db:start` first.
 *
 * Run with: bun tests/test-conflict-corpus.ts [--family-id=<uuid>] [--allow-remote-db]
 */
import 'dotenv/config';
import {
  createDatabaseClient,
  type DatabaseClient,
  ClaimRepository,
} from '@sobremesa/database';
import {
  canClaimTypeConflict,
  detectClaimConflict,
} from '@sobremesa/agents-registrar';
import type { Claim } from '@sobremesa/shared-types';
import {
  assertLocalUnlessAllowed,
  requireLiveDbEnv,
} from './live-db-test-utils.js';

interface ClaimRow {
  id: string;
  subject: string;
  claimType: string;
  claimValue: unknown;
  claimedAt: string;
  status: string;
}

interface ConflictPair {
  claimAId: string;
  claimBId: string;
  inClaimConflicts: boolean;
  inClaimRelationships: boolean;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Canonicalizes a claim value for loose comparison: numbers to strings,
 * strings trimmed/lowercased, object keys sorted -- so formatting-only
 * differences (case, whitespace, key order, "1891" vs 1891) collapse. */
function canonicalize(value: unknown): unknown {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value.trim().toLowerCase();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => [k, canonicalize(v)] as const)
      .sort(([a], [b]) => a.localeCompare(b));
  }
  return value;
}

function looksLikeFormattingOnly(values: unknown[]): boolean {
  const canonical = new Set(values.map((v) => JSON.stringify(canonicalize(v))));
  return canonical.size === 1;
}

function daysBetween(a: string, b: string): number {
  const diffMs = Math.abs(new Date(a).getTime() - new Date(b).getTime());
  return Math.round((diffMs / (1000 * 60 * 60 * 24)) * 10) / 10;
}

async function resolveFamilyId(
  client: DatabaseClient,
  explicit: string | undefined,
): Promise<string> {
  if (explicit) return explicit;

  const { data, error } = await client
    .from('conversation_events')
    .select('family_id')
    .not('ingestion_batch_id', 'is', null)
    .limit(10000);
  if (error) {
    throw new Error(`Failed to find imported families: ${error.message}`);
  }

  const ids = [...new Set((data ?? []).map((r) => r['family_id'] as string))];
  if (ids.length === 0) {
    throw new Error(
      'No family has any imported (ingestion_batch_id-tagged) conversation_events. ' +
        'Pass --family-id=<uuid> to target one explicitly.',
    );
  }
  if (ids.length > 1) {
    const { data: families } = await client
      .from('families')
      .select('id, name')
      .in('id', ids);
    const listing = (families ?? [])
      .map((f) => `  ${f['id']}  ${f['name']}`)
      .join('\n');
    throw new Error(
      `Multiple families have imported history; pass --family-id=<uuid> to pick one:\n${listing}`,
    );
  }
  return ids[0] as string;
}

async function fetchClaimsByIds(
  claimRepo: ClaimRepository,
  familyId: string,
  ids: string[],
): Promise<Map<string, ClaimRow>> {
  const map = new Map<string, ClaimRow>();
  if (ids.length === 0) return map;

  // Reuses ClaimRepository.findByIds (already family-scoped and excluding
  // 'redacted' claims) instead of a raw query, so a redacted claim in a
  // persisted conflict pair doesn't silently show up in this report.
  const claims = await claimRepo.findByIds(familyId, ids);
  for (const claim of claims) {
    map.set(claim.id, {
      id: claim.id,
      subject: claim.subject,
      claimType: claim.claimType,
      claimValue: claim.claimValue,
      // Claim.claimedAt is typed as Date but the repository mapper leaves it
      // as the raw string Supabase returns -- don't assume a Date instance.
      claimedAt: String(claim.claimedAt),
      status: claim.status,
    });
  }
  return map;
}

async function loadPersistedConflictPairs(
  client: DatabaseClient,
  familyId: string,
): Promise<{
  claimConflictsRowCount: number;
  claimConflictsPairs: Set<string>;
  claimRelationshipsRowCount: number;
  claimRelationshipsPairs: Set<string>;
}> {
  const { data: conflictRows, error: conflictError } = await client
    .from('claim_conflicts')
    .select('claim_id, conflicts_with_claim_id')
    .eq('family_id', familyId);
  if (conflictError) {
    throw new Error(`Failed to load claim_conflicts: ${conflictError.message}`);
  }
  const claimConflictsPairs = new Set<string>();
  for (const row of conflictRows ?? []) {
    claimConflictsPairs.add(
      pairKey(row['claim_id'], row['conflicts_with_claim_id']),
    );
  }

  const { data: relRows, error: relError } = await client
    .from('claim_relationships')
    .select('claim_id, related_claim_id')
    .eq('family_id', familyId)
    .eq('relationship_type', 'contradicts');
  if (relError) {
    throw new Error(`Failed to load claim_relationships: ${relError.message}`);
  }
  const claimRelationshipsPairs = new Set<string>();
  for (const row of relRows ?? []) {
    claimRelationshipsPairs.add(
      pairKey(row['claim_id'], row['related_claim_id']),
    );
  }

  return {
    claimConflictsRowCount: conflictRows?.length ?? 0,
    claimConflictsPairs,
    claimRelationshipsRowCount: relRows?.length ?? 0,
    claimRelationshipsPairs,
  };
}

function unionPairs(
  claimConflictsPairs: Set<string>,
  claimRelationshipsPairs: Set<string>,
): ConflictPair[] {
  const keys = new Set([...claimConflictsPairs, ...claimRelationshipsPairs]);
  const pairs: ConflictPair[] = [];
  for (const key of keys) {
    const [claimAId, claimBId] = key.split('|') as [string, string];
    pairs.push({
      claimAId,
      claimBId,
      inClaimConflicts: claimConflictsPairs.has(key),
      inClaimRelationships: claimRelationshipsPairs.has(key),
    });
  }
  return pairs;
}

function reportPersistedPairs(
  pairs: ConflictPair[],
  claimsById: Map<string, ClaimRow>,
): { comparatorReevaluated: number; comparatorStillFlags: number } {
  console.log(`\n=== Persisted conflict pairs (${pairs.length} total) ===\n`);
  if (pairs.length === 0) {
    console.log('  (none)');
    return { comparatorReevaluated: 0, comparatorStillFlags: 0 };
  }

  let comparatorReevaluated = 0;
  let comparatorStillFlags = 0;

  for (const pair of pairs) {
    const a = claimsById.get(pair.claimAId);
    const b = claimsById.get(pair.claimBId);
    const inBoth = pair.inClaimConflicts && pair.inClaimRelationships;
    const source = inBoth
      ? 'both tables'
      : pair.inClaimConflicts
        ? 'claim_conflicts only'
        : 'claim_relationships only';

    console.log(`  Pair ${pair.claimAId} <-> ${pair.claimBId}  [${source}]`);
    if (!a || !b) {
      console.log(
        `    (one or both claims not found -- dangling link; a=${!!a} b=${!!b})`,
      );
      console.log('');
      continue;
    }
    console.log(
      `    subject A: ${JSON.stringify(a.subject)}  (status: ${a.status})`,
    );
    console.log(
      `    subject B: ${JSON.stringify(b.subject)}  (status: ${b.status})`,
    );
    console.log(
      `    value A:   ${JSON.stringify(a.claimValue)}  @ ${a.claimedAt}`,
    );
    console.log(
      `    value B:   ${JSON.stringify(b.claimValue)}  @ ${b.claimedAt}`,
    );
    console.log(`    gap:       ${daysBetween(a.claimedAt, b.claimedAt)} days`);
    const formattingOnly = looksLikeFormattingOnly([
      a.claimValue,
      b.claimValue,
    ]);
    console.log(
      `    auto-hint: ${formattingOnly ? 'looks like formatting-only (probably not a real disagreement)' : 'values differ beyond formatting'}` +
        '  [hint only -- fill in manual read-through judgment separately]',
    );

    // agent-hygiene-plan.md #5d: replay this already-persisted pair's
    // recorded values through the fixed write-time comparator, read-only.
    // A new writer cannot repair an old stored link automatically -- this
    // only reports what the current code would decide, it never rewrites
    // claim_conflicts/claim_relationships.
    if (a.claimType === b.claimType) {
      comparatorReevaluated++;
      const stillFlagged = detectClaimConflict(
        a.claimValue as string | Record<string, unknown>,
        b.claimValue as string | Record<string, unknown>,
        a.claimType,
      );
      if (stillFlagged) comparatorStillFlags++;
      console.log(
        `    #5d comparator: ${stillFlagged ? 'STILL flags this pair as a conflict' : 'no longer flags this pair (legacy link, not a current decision)'}`,
      );
    }
    console.log('');
  }

  return { comparatorReevaluated, comparatorStillFlags };
}

async function simulateCrudeDetector(
  claimRepo: ClaimRepository,
  familyId: string,
): Promise<void> {
  const claims = await claimRepo.findAllActive(familyId);

  const bySubject = new Map<string, Claim[]>();
  for (const claim of claims) {
    const list = bySubject.get(claim.subject) ?? [];
    list.push(claim);
    bySubject.set(claim.subject, list);
  }

  const flaggedGroups: { subject: string; claims: Claim[] }[] = [];
  let flaggedIfTypeFiltered = 0;
  for (const [subject, group] of bySubject) {
    if (group.length < 2) continue;
    const values = group.map((c) => JSON.stringify(c.claimValue));
    if (new Set(values).size > 1) {
      flaggedGroups.push({ subject, claims: group });

      // What retriever.ts *doesn't* do: restrict to the claim types the
      // write-time detector treats as singular/conflictable (conflict-detector.ts
      // canClaimTypeConflict). 'detail' claims are explicitly additive/never-
      // conflicting there, but retriever.ts's grouping has no type filter at all.
      const conflictable = group.filter((c) =>
        canClaimTypeConflict(c.claimType),
      );
      const conflictableValues = conflictable.map((c) =>
        JSON.stringify(c.claimValue),
      );
      if (conflictable.length > 1 && new Set(conflictableValues).size > 1) {
        flaggedIfTypeFiltered++;
      }
    }
  }

  console.log(
    `\n=== Crude answer-time detector simulation (retriever.ts:615-641) ===\n`,
  );
  console.log(`  Active claims in corpus: ${claims.length}`);
  console.log(`  Distinct subjects:       ${bySubject.size}`);
  console.log(`  Subjects flagged as conflicting: ${flaggedGroups.length}`);
  console.log(
    `  Of those, still flagged if restricted to canClaimTypeConflict types ` +
      `(date/location/identity/relationship -- excluding additive 'detail'): ${flaggedIfTypeFiltered}\n`,
  );

  let formattingOnlyCount = 0;
  let possiblyGenuineCount = 0;
  for (const { subject, claims: group } of flaggedGroups) {
    const formattingOnly = looksLikeFormattingOnly(
      group.map((c) => c.claimValue),
    );
    if (formattingOnly) formattingOnlyCount++;
    else possiblyGenuineCount++;

    console.log(
      `  Subject ${JSON.stringify(subject)} -- ${group.length} claims -- ` +
        `${formattingOnly ? 'formatting-only (false positive)' : 'possibly genuine (needs review)'}`,
    );
    for (const c of group) {
      // Claim.claimedAt is typed as Date but the repository mapper leaves it
      // as the raw string Supabase returns -- don't assume a Date instance.
      console.log(
        `    ${c.id}  [${c.claimType}]  ${JSON.stringify(c.claimValue)}  @ ${c.claimedAt}`,
      );
    }
  }

  console.log(
    `\n  Of ${flaggedGroups.length} flagged subjects: ${formattingOnlyCount} formatting-only, ` +
      `${possiblyGenuineCount} possibly genuine.`,
  );
  console.log(
    `  False-positive-rate proxy: ${flaggedGroups.length === 0 ? 'n/a (nothing flagged)' : `${formattingOnlyCount}/${flaggedGroups.length}`} ` +
      `of what families would see flagged as a conflict is formatting-only.`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const allowRemoteDb = args.includes('--allow-remote-db');
  const familyIdArg = args
    .find((a) => a.startsWith('--family-id='))
    ?.split('=')[1];

  const env = requireLiveDbEnv('Conflict corpus report');
  assertLocalUnlessAllowed(env.url, allowRemoteDb);
  const client = createDatabaseClient(env);
  const claimRepo = new ClaimRepository(client);

  const familyId = await resolveFamilyId(client, familyIdArg);
  console.log(`Family: ${familyId}`);

  const {
    claimConflictsRowCount,
    claimConflictsPairs,
    claimRelationshipsRowCount,
    claimRelationshipsPairs,
  } = await loadPersistedConflictPairs(client, familyId);

  console.log(`\n=== Row / pair counts ===\n`);
  console.log(
    `  claim_conflicts:      ${claimConflictsRowCount} rows -> ${claimConflictsPairs.size} distinct pairs`,
  );
  console.log(
    `  claim_relationships:  ${claimRelationshipsRowCount} rows (relationship_type='contradicts') -> ${claimRelationshipsPairs.size} distinct pairs`,
  );

  const onlyInConflicts = [...claimConflictsPairs].filter(
    (k) => !claimRelationshipsPairs.has(k),
  );
  const onlyInRelationships = [...claimRelationshipsPairs].filter(
    (k) => !claimConflictsPairs.has(k),
  );
  const inBoth = [...claimConflictsPairs].filter((k) =>
    claimRelationshipsPairs.has(k),
  );
  console.log(`  in both tables:              ${inBoth.length}`);
  console.log(`  only in claim_conflicts:     ${onlyInConflicts.length}`);
  console.log(`  only in claim_relationships: ${onlyInRelationships.length}`);
  console.log(
    onlyInConflicts.length === 0 && onlyInRelationships.length === 0
      ? '  -> the two tables agree exactly.'
      : '  -> the two tables disagree; see per-pair source column below.',
  );

  const pairs = unionPairs(claimConflictsPairs, claimRelationshipsPairs);
  const allClaimIds = [
    ...new Set(pairs.flatMap((p) => [p.claimAId, p.claimBId])),
  ];
  const claimsById = await fetchClaimsByIds(claimRepo, familyId, allClaimIds);
  const { comparatorReevaluated, comparatorStillFlags } = reportPersistedPairs(
    pairs,
    claimsById,
  );
  console.log(
    `\n=== #5d comparator re-check summary ===\n\n` +
      `  Persisted pairs re-evaluated: ${comparatorReevaluated}\n` +
      `  Still flagged by the current comparator: ${comparatorStillFlags}\n` +
      `  No longer flagged (legacy link from the pre-#5d comparator): ${comparatorReevaluated - comparatorStillFlags}\n`,
  );

  await simulateCrudeDetector(claimRepo, familyId);
}

main().catch((err) => {
  console.error('Conflict corpus report failed with error:', err);
  process.exit(1);
});
