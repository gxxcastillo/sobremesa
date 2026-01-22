# Data Integrity & Testing Plan

> **Part of**: [Data Architecture Overview](./2026-01-21-data-architecture-overview.md) - Start here for the big picture

## Overview

This document explores tooling for:

1. **Data Integrity Validation** - Verify referential integrity and data consistency
2. **Replay/Rebuild Tooling** - Re-process conversation_events to detect regressions
3. **Testing Infrastructure** - Automated verification of the data pipeline

---

## Part 1: Data Integrity Validation

### 1.1 What Needs Validation

The schema uses a mix of foreign key constraints (enforced by DB) and polymorphic references (NOT enforced). We need tooling to validate the unenforced relationships.

#### FK-Enforced (DB validates automatically)

- `claims.source_event_id` → `conversation_events.id`
- `claims.family_id` → `families.id`
- `claim_entities.claim_id` → `claims.id` (composite FK)
- `entity_merges.trigger_event_id` → `conversation_events.id`
- `identity_claims.claim_id` → `claims.id` (composite FK)
- `story_entities.story_id` → `stories.id` (composite FK)
- `event_participants.event_id` → `events.id` (composite FK)

#### NOT FK-Enforced (requires validation tooling)

| Table                    | Column                                    | Should Reference                           | Why Not FK  |
| ------------------------ | ----------------------------------------- | ------------------------------------------ | ----------- |
| `claims`                 | `entity_id` + `entity_type`               | people/places/events/stories               | Polymorphic |
| `claim_entities`         | `entity_id` + `entity_type`               | people/places/events/stories/relationships | Polymorphic |
| `story_entities`         | `entity_id` + `entity_type`               | people/places/events                       | Polymorphic |
| `event_participants`     | `entity_id` + `entity_type`               | people/places                              | Polymorphic |
| `entity_merges`          | `source_entity_id` + `source_entity_type` | people/places/events/stories               | Polymorphic |
| `entity_merges`          | `target_entity_id` + `target_entity_type` | people/places/events/stories               | Polymorphic |
| `entity_cluster_members` | `entity_id` + `entity_type`               | people/places/events                       | Polymorphic |

#### Cross-Family Integrity (trigger-enforced, but worth validating)

- `entity_merges.trigger_event_id` must belong to same `family_id`
- `identity_claims.descriptive_person_id` must belong to same `family_id`
- `identity_claims.canonical_person_id` must belong to same `family_id`

#### Logical Consistency

- Entities (people, places, events, stories) with `superseded_by` should have corresponding `entity_merges` record
- `identity_claims.resolved = true` should have `entity_merge_id` set
- No circular merge chains (trigger-enforced, but worth validating)

---

### 1.2 Validation Queries

```sql
-- ============================================================
-- POLYMORPHIC REFERENCE VALIDATION
-- ============================================================

-- 1. Claims with invalid entity references
SELECT c.id, c.family_id, c.entity_id, c.entity_type, 'claims.entity_id' as source
FROM claims c
WHERE c.entity_id IS NOT NULL
  AND c.entity_type IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM people p WHERE p.id = c.entity_id AND c.entity_type = 'person' AND p.family_id = c.family_id
    UNION ALL
    SELECT 1 FROM places p WHERE p.id = c.entity_id AND c.entity_type = 'place' AND p.family_id = c.family_id
    UNION ALL
    SELECT 1 FROM events e WHERE e.id = c.entity_id AND c.entity_type = 'event' AND e.family_id = c.family_id
    UNION ALL
    SELECT 1 FROM stories s WHERE s.id = c.entity_id AND c.entity_type = 'story' AND s.family_id = c.family_id
  );

-- 2. claim_entities with invalid entity references
SELECT ce.claim_id, ce.family_id, ce.entity_id, ce.entity_type, 'claim_entities.entity_id' as source
FROM claim_entities ce
WHERE NOT EXISTS (
    SELECT 1 FROM people p WHERE p.id = ce.entity_id AND ce.entity_type = 'person' AND p.family_id = ce.family_id
    UNION ALL
    SELECT 1 FROM places p WHERE p.id = ce.entity_id AND ce.entity_type = 'place' AND p.family_id = ce.family_id
    UNION ALL
    SELECT 1 FROM events e WHERE e.id = ce.entity_id AND ce.entity_type = 'event' AND e.family_id = ce.family_id
    UNION ALL
    SELECT 1 FROM stories s WHERE s.id = ce.entity_id AND ce.entity_type = 'story' AND s.family_id = ce.family_id
    UNION ALL
    SELECT 1 FROM relationships r WHERE r.id = ce.entity_id AND ce.entity_type = 'relationship' AND r.family_id = ce.family_id
  );

-- 3. story_entities with invalid entity references
SELECT se.story_id, se.family_id, se.entity_id, se.entity_type, 'story_entities.entity_id' as source
FROM story_entities se
WHERE NOT EXISTS (
    SELECT 1 FROM people p WHERE p.id = se.entity_id AND se.entity_type = 'person' AND p.family_id = se.family_id
    UNION ALL
    SELECT 1 FROM places p WHERE p.id = se.entity_id AND se.entity_type = 'place' AND p.family_id = se.family_id
    UNION ALL
    SELECT 1 FROM events e WHERE e.id = se.entity_id AND se.entity_type = 'event' AND e.family_id = se.family_id
  );

-- 4. event_participants with invalid entity references
SELECT ep.event_id, ep.family_id, ep.entity_id, ep.entity_type, 'event_participants.entity_id' as source
FROM event_participants ep
WHERE NOT EXISTS (
    SELECT 1 FROM people p WHERE p.id = ep.entity_id AND ep.entity_type = 'person' AND p.family_id = ep.family_id
    UNION ALL
    SELECT 1 FROM places p WHERE p.id = ep.entity_id AND ep.entity_type = 'place' AND p.family_id = ep.family_id
  );

-- 5. entity_merges with invalid source/target references
SELECT em.id, em.family_id, em.source_entity_id, em.source_entity_type, 'entity_merges.source' as source
FROM entity_merges em
WHERE NOT EXISTS (
    SELECT 1 FROM people p WHERE p.id = em.source_entity_id AND em.source_entity_type = 'person' AND p.family_id = em.family_id
    UNION ALL
    SELECT 1 FROM places p WHERE p.id = em.source_entity_id AND em.source_entity_type = 'place' AND p.family_id = em.family_id
    UNION ALL
    SELECT 1 FROM events e WHERE e.id = em.source_entity_id AND em.source_entity_type = 'event' AND e.family_id = em.family_id
    UNION ALL
    SELECT 1 FROM stories s WHERE s.id = em.source_entity_id AND em.source_entity_type = 'story' AND s.family_id = em.family_id
  );

-- (Similar query for target_entity_id)

-- ============================================================
-- LOGICAL CONSISTENCY VALIDATION
-- ============================================================

-- 6. Entities marked superseded without corresponding entity_merge record
SELECT 'people' as table_name, p.id, p.family_id, p.superseded_by
FROM people p
WHERE p.superseded_by IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM entity_merges em
    WHERE em.source_entity_id = p.id
      AND em.source_entity_type = 'person'
      AND em.target_entity_id = p.superseded_by
      AND em.family_id = p.family_id
  );
-- (Repeat for places, events, stories)

-- 7. entity_merges record exists but entity not marked superseded
SELECT em.id, em.source_entity_id, em.source_entity_type, em.target_entity_id
FROM entity_merges em
WHERE em.source_entity_type = 'person'
  AND NOT EXISTS (
    SELECT 1 FROM people p
    WHERE p.id = em.source_entity_id
      AND p.superseded_by = em.target_entity_id
      AND p.family_id = em.family_id
  );
-- (Repeat for places, events, stories)

-- 8. identity_claims marked resolved without entity_merge_id
SELECT ic.id, ic.family_id, ic.descriptive_name, ic.canonical_name
FROM identity_claims ic
WHERE ic.resolved = TRUE
  AND ic.entity_merge_id IS NULL;

-- 9. Orphaned claims (no entity links via claim_entities or legacy entity_id)
SELECT c.id, c.family_id, c.subject, c.claim_type
FROM claims c
WHERE c.entity_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM claim_entities ce
    WHERE ce.claim_id = c.id AND ce.family_id = c.family_id
  )
  AND c.claim_type NOT IN ('identity');  -- Identity claims may not have entity links

-- 10. Circular merge detection (backup validation for trigger)
WITH RECURSIVE merge_chain AS (
  SELECT source_entity_id, target_entity_id, source_entity_type, family_id,
         ARRAY[source_entity_id] as path, FALSE as is_cycle, 1 as depth
  FROM entity_merges

  UNION ALL

  SELECT mc.source_entity_id, em.target_entity_id, mc.source_entity_type, mc.family_id,
         mc.path || em.target_entity_id,
         em.target_entity_id = ANY(mc.path),
         mc.depth + 1
  FROM merge_chain mc
  JOIN entity_merges em ON em.source_entity_id = mc.target_entity_id
    AND em.source_entity_type = mc.source_entity_type
    AND em.family_id = mc.family_id
  WHERE mc.depth < 100 AND NOT mc.is_cycle
)
SELECT DISTINCT source_entity_id, source_entity_type, family_id, path
FROM merge_chain
WHERE is_cycle = TRUE;
```

---

### 1.3 Validation Tooling Options

#### Option A: SQL Scripts (Manual)

- Run queries manually or via `psql`
- Pros: Simple, no code to maintain
- Cons: Manual process, no alerting

#### Option B: Database Functions

```sql
CREATE OR REPLACE FUNCTION validate_data_integrity()
RETURNS TABLE(
  check_name TEXT,
  issue_count BIGINT,
  sample_ids UUID[]
) AS $$
BEGIN
  -- Run all validation queries, return summary
  ...
END;
$$ LANGUAGE plpgsql;

-- Usage: SELECT * FROM validate_data_integrity();
```

- Pros: Callable from app or CLI, returns structured results
- Cons: Complex SQL, harder to maintain

#### Option C: TypeScript CLI Tool

```
nx run db:validate-integrity [--family-id <id>] [--fix]
```

- Pros: Rich output, can integrate with logging/alerting, optional auto-fix
- Cons: More code to maintain

#### Option D: Scheduled Supabase Edge Function

- Runs daily, logs results, alerts on issues
- Pros: Automated, no manual intervention
- Cons: Supabase-specific, limited debugging

**Recommendation**: Start with **Option C** (TypeScript CLI) for development/debugging, add **Option D** (scheduled function) for production monitoring.

---

### 1.4 When to Run Validation

| Trigger            | Use Case                                     |
| ------------------ | -------------------------------------------- |
| After migrations   | Verify schema changes didn't break integrity |
| After bulk imports | Validate imported data                       |
| Daily scheduled    | Catch drift/corruption early                 |
| Before releases    | CI/CD gate                                   |
| On-demand          | Debugging specific issues                    |

---

## Part 2: Replay/Rebuild Tooling

### 2.1 The Challenge: LLM Non-Determinism

The Scribe agent uses Claude to extract entities and claims. The same input message may produce:

- Different entity names ("Maria García" vs "María Garcia")
- Different confidence levels
- Additional or fewer extracted facts
- Slightly different claim phrasing

This makes exact comparison difficult.

### 2.2 Replay Approaches

#### Approach A: Full Pipeline Replay (Scribe + Registrar)

```
conversation_events → Scribe (LLM) → DomainModel → Registrar → shadow tables
```

**Process:**

1. Create shadow tables (`claims_replay`, `people_replay`, etc.)
2. Re-run each conversation_event through Scribe → Registrar
3. Compare shadow tables with production tables
4. Generate diff report

**Comparison challenges:**

- UUIDs will differ (new records get new IDs)
- Timestamps will differ
- LLM extraction may differ

**Comparison strategy:**

```typescript
interface ReplayComparison {
  // Exact matches (same subject + claim_value)
  matched: number;
  // Same subject, different value (potential regression)
  diverged: number;
  // In replay but not production (new extraction)
  added: number;
  // In production but not replay (lost extraction)
  missing: number;
}
```

**Cost**: ~$0.01-0.05 per message (Claude API) × number of messages

**When useful:**

- Major Scribe prompt changes
- Testing extraction quality improvements
- Full system validation

#### Approach B: Registrar-Only Replay (Deterministic)

```
stored DomainModels → Registrar → shadow tables
```

**Requires**: Storing the `ScribeDomainModel` output somewhere (new table or in conversation_events.metadata)

**Process:**

1. Store Scribe output in `conversation_events.scribe_output JSONB`
2. Re-run stored output through Registrar only
3. Compare results (deterministic - same input = same output)

**Pros:**

- Deterministic comparison
- No LLM costs
- Tests Registrar logic specifically

**Cons:**

- Requires schema change to store Scribe output
- Doesn't test Scribe changes

**When useful:**

- Registrar refactoring (e.g., the data architecture changes)
- Testing persistence logic
- Debugging specific events

#### Approach C: Golden Test Fixtures

```
curated_messages → Scribe → expected_output (committed to repo)
```

**Process:**

1. Curate ~50-100 representative messages
2. Run through Scribe, manually verify output
3. Commit expected output as test fixtures
4. CI runs Scribe on inputs, compares to expected output
5. Allow "semantic equivalence" (not exact match)

**Comparison strategy:**

```typescript
function semanticallyEquivalent(
  expected: DomainModel,
  actual: DomainModel,
): boolean {
  // Same people extracted (by normalized name)?
  // Same claim types and subjects?
  // Confidence within acceptable range?
  // Allow ordering differences
}
```

**Pros:**

- Fast (small dataset)
- Deterministic pass/fail
- Documents expected behavior

**Cons:**

- Requires manual curation
- May not catch edge cases
- Needs maintenance as expectations evolve

**When useful:**

- CI/CD regression testing
- Documenting expected extraction behavior
- Testing prompt changes

#### Approach D: Statistical Sampling

```
random 10% of conversation_events → Full replay → Statistical comparison
```

**Process:**

1. Randomly sample N% of events
2. Full pipeline replay
3. Compute aggregate metrics (not per-record comparison)
4. Alert if metrics deviate significantly

**Metrics:**

```typescript
interface ReplayMetrics {
  avgClaimsPerMessage: number;
  avgEntitiesPerMessage: number;
  confidenceDistribution: Record<string, number>;
  claimTypeDistribution: Record<string, number>;
  conflictRate: number;
}
```

**Pros:**

- Cost-effective
- Catches systematic regressions
- Handles LLM non-determinism gracefully

**Cons:**

- May miss rare edge cases
- Requires baseline metrics to compare against

**When useful:**

- Monitoring extraction quality over time
- A/B testing prompt changes
- Validating model upgrades

---

### 2.3 Comparison: Replay Approaches

| Approach           | Tests Scribe | Tests Registrar | Deterministic | Cost   | CI-Friendly |
| ------------------ | ------------ | --------------- | ------------- | ------ | ----------- |
| A: Full Replay     | ✅           | ✅              | ❌            | High   | ❌          |
| B: Registrar-Only  | ❌           | ✅              | ✅            | Free   | ✅          |
| C: Golden Fixtures | ✅           | ❌              | ~✅           | Low    | ✅          |
| D: Statistical     | ✅           | ✅              | ❌            | Medium | ⚠️          |

---

### 2.4 Recommendation

**For the data architecture redesign specifically:**

Use **Approach B (Registrar-Only Replay)** because:

- The changes are primarily in Registrar, not Scribe
- Deterministic comparison is possible
- No LLM costs
- Can run in CI

**Implementation:**

1. Add `scribe_output JSONB` column to `conversation_events` (or separate table)
2. Modify Scribe to store its output after processing
3. Create replay tool that reads stored output and runs through Registrar
4. Compare against production data

> **Note**: This Scribe output storage requirement is not yet included in the main data architecture plan or chatbots app plan. It should be added to Phase 1 of the migration as an optional (but recommended) enhancement for debugging and replay capabilities. See [Open Questions](#open-questions) section below.

**For ongoing regression testing:**

Use **Approach C (Golden Fixtures)** because:

- Fast enough for CI
- Documents expected behavior
- Catches major regressions in Scribe

**For production monitoring:**

Use **Approach D (Statistical Sampling)** because:

- Cost-effective for large datasets
- Handles LLM non-determinism
- Catches systematic quality degradation

---

## Part 3: Testing Infrastructure

### 3.1 Test Categories

| Category                  | What It Tests                  | When to Run              |
| ------------------------- | ------------------------------ | ------------------------ |
| Unit tests                | Individual functions           | Every commit             |
| Integration tests         | Agent + Repository interaction | Every commit             |
| Golden fixture tests      | Scribe extraction quality      | Every commit             |
| Registrar replay tests    | Persistence logic              | Before releases          |
| Data integrity validation | Production data consistency    | Daily + after migrations |
| Statistical sampling      | Overall extraction quality     | Weekly or after changes  |

### 3.2 Proposed Test Structure

```
libs/
  agents/
    registrar/
      src/lib/
        registrar.spec.ts           # Unit tests
        registrar.integration.spec.ts  # With real DB
    scribe/
      src/lib/
        scribe.spec.ts              # Unit tests (mocked LLM)
        scribe.golden.spec.ts       # Golden fixture tests

apps/
  db/
    scripts/
      validate-integrity.ts         # CLI for integrity checks
      replay-registrar.ts           # CLI for Registrar replay

tests/
  fixtures/
    golden/
      messages/                     # Input messages
        immigration-story.json
        birth-announcement.json
        identity-claim.json
        ...
      expected/                     # Expected Scribe output
        immigration-story.json
        birth-announcement.json
        identity-claim.json
        ...
  e2e/
    full-pipeline.spec.ts           # End-to-end tests
```

### 3.3 Golden Fixture Format

```json
// tests/fixtures/golden/messages/identity-claim.json
{
  "id": "test-identity-claim-001",
  "description": "Identity claim revealing real name",
  "input": {
    "content_original": "By the way, the woman Dexter married is actually named Judy Doran. We always called her 'Dexter's wife' but her real name is Judy.",
    "language_original": "en",
    "actor_display_name": "Maria",
    "occurred_at": "2024-01-15T10:30:00Z"
  },
  "expected": {
    "people": [
      { "name": "Judy Doran", "aliases": ["Dexter's wife"] },
      { "name": "Dexter" }
    ],
    "claims": [
      {
        "claimType": "identity",
        "subject": "Dexter's wife",
        "claimValue": { "real_name": "Judy Doran" },
        "confidence": "high"
      }
    ],
    "relationships": [
      {
        "personAName": "Dexter",
        "personBName": "Judy Doran",
        "relationshipType": "spouse"
      }
    ]
  },
  "comparison": {
    "allowAdditionalPeople": true,
    "allowAdditionalClaims": true,
    "confidenceTolerance": 1 // Allow ±1 level (high ↔ medium)
  }
}
```

---

## Part 4: Implementation Roadmap

### Phase 1: Data Integrity Validation (Immediate)

1. Create `apps/db/scripts/validate-integrity.ts`
2. Implement validation queries as TypeScript functions
3. Add to CI as optional check
4. Document usage in README

### Phase 2: Registrar Replay (Before Data Architecture Changes)

1. Add `scribe_output` column to `conversation_events`
2. Modify Scribe to store output
3. Create `apps/db/scripts/replay-registrar.ts`
4. Run replay before/after Registrar refactoring
5. Compare results to validate changes

### Phase 3: Golden Fixtures (Ongoing)

1. Create fixture structure in `tests/fixtures/golden/`
2. Curate initial set of ~20 representative messages
3. Implement `scribe.golden.spec.ts` with semantic comparison
4. Add to CI pipeline

### Phase 4: Production Monitoring (Post-Launch)

1. Create Supabase Edge Function for daily integrity checks
2. Set up alerting for integrity failures
3. Implement statistical sampling for extraction quality
4. Create dashboard for quality metrics

---

## Open Questions

1. **Should Scribe output be stored permanently?**
   - Pro: Enables replay, debugging, audit trail
   - Con: Storage cost, data duplication
   - Middle ground: Store for N days, then delete?

2. **What's acceptable divergence for golden fixtures?**
   - Exact match on entities?
   - Allow synonym variations ("Maria" vs "María")?
   - Allow confidence level differences?

3. **Who should be alerted on integrity failures?**
   - Silent logging?
   - Email/Slack alerts?
   - Block processing until resolved?

4. **Should replay be per-family or global?**
   - Per-family: Useful for debugging specific issues
   - Global: Needed for schema migration validation

---

## Summary

| Tool                     | Purpose                       | Priority | Effort |
| ------------------------ | ----------------------------- | -------- | ------ |
| Integrity validation CLI | Catch data corruption         | High     | Low    |
| Registrar replay         | Validate Registrar changes    | High     | Medium |
| Golden fixtures          | CI regression testing         | Medium   | Medium |
| Statistical sampling     | Production quality monitoring | Low      | Medium |
| Scheduled validation     | Automated monitoring          | Low      | Low    |
