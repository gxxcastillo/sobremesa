# Data Architecture Redesign Plan: Robust Ingestion & Entity Resolution

> **Part of**: [Data Architecture Overview](./2026-01-21-data-architecture-overview.md) - Start here for the big picture

## Executive Summary

This plan addresses three key objectives:

1. **Robust, immutable conversation_events** - Strengthen the foundational event ledger
2. **Extensible entity ingestion** - Improve entity resolution with full provenance, auditability, and reversibility
3. **Knowledge graph readiness** - Prepare the architecture for future KG integration

## Key Design Decisions

Summary of key architectural choices:

1. **Per-family sequence numbers** - Uses atomic counter table (`family_sequence_counters`) to avoid race conditions in concurrent inserts
2. **claim_entities replaces entity_evidence** - Many-to-many join table for claim-entity relationships, supporting multi-entity claims
3. **claims.entity_id deprecated** - Made nullable; use claim_entities for all entity associations
4. **Polymorphic event_participants** - Like story_entities, supports both people and places (for location context)
5. **Identity claims people-only** - Removed entity_type field; identity resolution is exclusively for people; `canonical_name` is nullable (may not be known initially)
6. **Clean join table pattern** - Consistent polymorphic design across story_entities, event_participants, claim_entities, and entity_cluster_members. **All join tables include `family_id`** with **composite foreign keys** (e.g., `FOREIGN KEY (family_id, claim_id) REFERENCES claims(family_id, id)`) that enforce tenant integrity at the DB level - no app-layer validation needed.
7. **entity_merges is mutable and deletable** - Records active merges; superseded_by columns are denormalized for query performance. **Merges can be deleted** (no status workflow) - provenance is preserved in immutable `claims` and `identity_claims` tables. Event logs capture deletions if audit trail needed.
8. **Circular merge prevention** - Database trigger traverses **`entity_merges` table directly** (not denormalized columns) to prevent A→B→C→A merge cycles
9. **Claim cascade queries** - `get_entity_merge_chain()` helper finds claims across merged entity predecessors
10. **LLM evaluation via flag polling with locking** - No separate queue table; uses `needs_llm_evaluation` + `llm_evaluated_at` columns. **Includes lock/lease mechanism** (`llm_eval_locked_at`, `llm_eval_locked_by`) to prevent duplicate processing by concurrent workers.

## Current State Analysis

### Strengths

- ✅ **conversation_events is already immutable** - Triggers prevent UPDATE/DELETE
- ✅ **Claims-based provenance** - Every fact traces to source_event_id
- ✅ **Conflict preservation** - claim_conflicts table prevents auto-resolution
- ✅ **Multi-language support** - Original language preserved with \_original suffix
- ✅ **Scribe→Registrar separation** - Clean extraction vs persistence boundary
- ✅ **Identity claims** - Handle descriptive→real name resolution

### Gaps Identified

#### 1. conversation_events Gaps

- ❌ **No event ordering guarantee** - No sequence numbers for strict ordering
- ❌ **No schema versioning** - Can't evolve source_payload structure safely
- ❌ **Limited metadata structure** - JSONB metadata is untyped
- ❌ **No deduplication check** - Same external event could theoretically be ingested twice

#### 2. Entity Resolution Gaps

- ❌ **Entity merges not tracked** - When Registrar deduplicates people, no audit trail of merge decision
- ❌ **No entity versioning** - Can't see how an entity evolved over time
- ❌ **Weak evidence links** - Claims link to entities via polymorphic (entity_id, entity_type), but no reverse index
- ❌ **No merge reversibility** - Once people are merged, can't undo without data loss
- ❌ **Identity claims stored as regular claims** - Should be a first-class concept

#### 3. Knowledge Graph Gaps

- ❌ **No graph metadata** - Missing node/edge properties needed for Neo4j/graph export
- ❌ **Limited relationship semantics** - No temporal bounds on relationships (start_date, end_date)
- ❌ **No community/cluster tracking** - Can't group related entities
- ❌ **No GEDCOM compatibility layer** - Can't export to standard genealogy format

## Proposed Architecture

### Phase 1: Strengthen conversation_events (Immutable Ledger)

#### 1.1 Add Event Sequencing

**Goal**: Guarantee strict per-family ordering even if occurred_at timestamps collide

**Changes**:

```sql
-- ============================================
-- SAFE MIGRATION ORDER FOR EXISTING DATA
-- ============================================

-- Step 1: Add column as NULLABLE (no default yet)
ALTER TABLE conversation_events
  ADD COLUMN sequence_number BIGINT;

-- Step 2: Counter table for atomic sequence assignment
CREATE TABLE family_sequence_counters (
  family_id UUID PRIMARY KEY REFERENCES families(id),
  next_sequence BIGINT NOT NULL DEFAULT 1
);

-- Step 3: Backfill existing events deterministically (by occurred_at, then created_at, then id)
WITH numbered_events AS (
  SELECT id, family_id,
         ROW_NUMBER() OVER (PARTITION BY family_id ORDER BY occurred_at, created_at, id) as seq
  FROM conversation_events
)
UPDATE conversation_events ce
SET sequence_number = ne.seq
FROM numbered_events ne
WHERE ce.id = ne.id;

-- Step 4: Initialize counters to MAX+1 per family (AFTER backfill)
INSERT INTO family_sequence_counters (family_id, next_sequence)
SELECT family_id, COALESCE(MAX(sequence_number), 0) + 1
FROM conversation_events
GROUP BY family_id
ON CONFLICT (family_id) DO UPDATE SET next_sequence = EXCLUDED.next_sequence;

-- Step 5: Now make column NOT NULL
ALTER TABLE conversation_events
  ALTER COLUMN sequence_number SET NOT NULL;

-- Trigger to atomically assign per-family sequence numbers
-- Uses UPDATE ... RETURNING for atomic increment (no race conditions)
CREATE OR REPLACE FUNCTION assign_event_sequence_number()
RETURNS TRIGGER AS $$
DECLARE
  assigned_sequence BIGINT;
BEGIN
  -- Atomically increment and return the sequence number
  UPDATE family_sequence_counters
  SET next_sequence = next_sequence + 1
  WHERE family_id = NEW.family_id
  RETURNING next_sequence - 1 INTO assigned_sequence;

  -- If no counter exists yet, create one (handles new families)
  IF assigned_sequence IS NULL THEN
    INSERT INTO family_sequence_counters (family_id, next_sequence)
    VALUES (NEW.family_id, 2)
    ON CONFLICT (family_id) DO UPDATE SET next_sequence = family_sequence_counters.next_sequence + 1
    RETURNING next_sequence - 1 INTO assigned_sequence;
  END IF;

  NEW.sequence_number := assigned_sequence;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_event_sequence_number
  BEFORE INSERT ON conversation_events
  FOR EACH ROW
  EXECUTE FUNCTION assign_event_sequence_number();

CREATE INDEX idx_conv_events_family_sequence
  ON conversation_events(family_id, sequence_number);

-- Unique index prevents duplicate sequence numbers per family
-- Note: Gaps are acceptable and can occur if inserts roll back. Ordering is monotonic.
CREATE UNIQUE INDEX idx_conv_events_family_sequence_unique
  ON conversation_events(family_id, sequence_number);
```

**Why counter table instead of MAX()?**

- The naive `SELECT MAX(sequence_number) + 1` approach has a race condition
- Two concurrent inserts could read the same MAX before either commits
- The counter table with `UPDATE ... RETURNING` is atomic and handles concurrency correctly
- Row-level lock on the counter prevents duplicate sequence numbers

**Benefits**:

- Deterministic per-family ordering for event replay
- Can rebuild each family's entities independently by replaying events in order
- Sequence numbers are meaningful within family context
- Useful for debugging and data recovery
- **Concurrent-safe**: No race conditions under high ingestion load

#### 1.2 Add Schema Versioning

**Goal**: Allow source_payload and metadata to evolve safely

**Changes**:

```sql
ALTER TABLE conversation_events
  ADD COLUMN payload_version INTEGER DEFAULT 1,
  ADD COLUMN metadata_version INTEGER DEFAULT 1;
```

**Benefits**:

- Can migrate old payload formats without breaking queries
- Schema evolution becomes explicit and trackable

#### 1.3 Strengthen Deduplication Check

**Goal**: Prevent accidental re-ingestion of same event

**Current**: Unique constraint on (family_id, source, conversation_id, external_event_id)

**Enhancement**: Add application-level validation before insert

- Check HMAC against recent events (last 1000)
- Log attempted duplicates to event_log

#### 1.4 Add Event Batch Tracking

**Goal**: Track ingestion batches for audit and rollback

**Scope**: IngestionBatch is used for:

- Cron job ingestions (scheduled imports)
- Manual/historical bulk imports
- **NOT** for real-time Telegram polling (messages processed individually via Telegraf long-polling)

**Rationale**: Real-time Telegram polling typically returns 0-1 messages per poll for a family chat. IngestionBatch adds overhead without meaningful grouping in this flow. The `sequence_number` + `created_at` on conversation_events provides sufficient ordering and debugging for real-time messages.

**Changes**:

```sql
CREATE TABLE ingestion_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id),
  source VARCHAR(50) NOT NULL,
  -- Wall-clock time when ingestion job started/ended (NOT event timestamps)
  ingestion_started_at TIMESTAMPTZ NOT NULL,
  ingestion_ended_at TIMESTAMPTZ,      -- NULL until batch completes
  event_count INTEGER,                 -- NULL until batch completes
  status VARCHAR(20) DEFAULT 'in_progress', -- 'in_progress', 'completed', 'partial', 'failed'
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE conversation_events
  ADD COLUMN ingestion_batch_id UUID REFERENCES ingestion_batches(id);
  -- Nullable: only populated for batch operations (cron jobs, manual imports)
  -- Real-time Telegram messages have NULL ingestion_batch_id
```

**Benefits**:

- Can identify and rollback bad batch imports (not applicable to real-time messages)
- Track ingestion health for scheduled jobs over time
- Useful for data quality monitoring of bulk operations

---

### Phase 2: Extensible Entity Ingestion with Full Auditability

#### 2.1 Track Entity Merges (Simple Approach)

**Goal**: Track when entities are merged, enable reversal

**Key Insight**: We don't need separate version history tables because **claims already provide complete temporal provenance**. Every claim has `source_event_id`, `created_at`, and `entity_id`, so we can reconstruct what was known at any point in time by querying claims.

**Entity tables are just materialized views** for query performance. The canonical truth lives in claims.

> **ARCHITECTURAL INVARIANT: Merge Records and Provenance**
>
> **`entity_merges` tracks active merges. `claims` provides immutable provenance.**
>
> - **Source of truth for facts**: `claims` table (immutable, with `source_event_id` provenance)
> - **Active merges**: `entity_merges` table (mutable, deletable)
> - **Derived cache**: `superseded_by` and `superseded_at` columns on entity tables
>
> **Sync contract:**
>
> - Registrar writes to `entity_merges` AND updates `superseded_by` in the same transaction
> - If `entity_merges` has a record for A→B, then `A.superseded_by = B`
> - If they ever diverge, `entity_merges` wins (rebuild cache from it)
> - No other component may write to `superseded_by` directly
>
> **Deleting a merge:**
>
> - Delete the `entity_merges` record
> - Clear `superseded_by` on the source entity
> - For identity-claim merges: set `identity_claims.resolved = FALSE` (the FK is ON DELETE SET NULL)
> - The underlying `claim` remains immutable - provenance is preserved
> - Event logs can capture the deletion with original reason if audit trail needed
>
> **Implication**: Entity tables can be fully reconstructed by replaying claims + applying merges from `entity_merges`. If an entity table is corrupted or inconsistent, re-process the relevant `conversation_events` through Scribe→Registrar pipeline.

**Changes**:

```sql
-- First, add composite unique constraints to enable tenant-safe FKs
-- (These may already exist from other migrations)
ALTER TABLE people ADD CONSTRAINT uq_people_family_id UNIQUE (family_id, id);
ALTER TABLE places ADD CONSTRAINT uq_places_family_id UNIQUE (family_id, id);
ALTER TABLE events ADD CONSTRAINT uq_events_family_id UNIQUE (family_id, id);
ALTER TABLE stories ADD CONSTRAINT uq_stories_family_id UNIQUE (family_id, id);

-- Add merge tracking to core entity tables (denormalized from entity_merges for query performance)
-- These columns are populated by Registrar when creating entity_merge records
-- Note: merge_reason is NOT stored here (it lives on entity_merges)
ALTER TABLE people
  ADD COLUMN superseded_by UUID,
  ADD COLUMN superseded_at TIMESTAMPTZ,
  ADD CONSTRAINT fk_people_superseded_by
    FOREIGN KEY (family_id, superseded_by) REFERENCES people(family_id, id);

ALTER TABLE places
  ADD COLUMN superseded_by UUID,
  ADD COLUMN superseded_at TIMESTAMPTZ,
  ADD CONSTRAINT fk_places_superseded_by
    FOREIGN KEY (family_id, superseded_by) REFERENCES places(family_id, id);

ALTER TABLE events
  ADD COLUMN superseded_by UUID,
  ADD COLUMN superseded_at TIMESTAMPTZ,
  ADD CONSTRAINT fk_events_superseded_by
    FOREIGN KEY (family_id, superseded_by) REFERENCES events(family_id, id);

ALTER TABLE stories
  ADD COLUMN superseded_by UUID,
  ADD COLUMN superseded_at TIMESTAMPTZ,
  ADD CONSTRAINT fk_stories_superseded_by
    FOREIGN KEY (family_id, superseded_by) REFERENCES stories(family_id, id);

-- Index for querying current (non-superseded) entities
CREATE INDEX idx_people_current
  ON people(family_id)
  WHERE superseded_by IS NULL;

CREATE INDEX idx_places_current
  ON places(family_id)
  WHERE superseded_by IS NULL;

CREATE INDEX idx_events_current
  ON events(family_id)
  WHERE superseded_by IS NULL;

CREATE INDEX idx_stories_current
  ON stories(family_id)
  WHERE superseded_by IS NULL;
```

**Benefits**:

- Simple schema (just 3 columns per entity table)
- Can query current entities: `WHERE superseded_by IS NULL`
- Can trace merge chains: follow superseded_by → target
- Temporal history via claims table (no redundant storage)
- Easy to undo merges by deleting entity_merges record

**Why This Works**:

- Claims table already tracks all facts with timestamps
- To see "what we knew about Maria on 2025-06-01": query claims WHERE entity_id = maria AND created_at <= '2025-06-01'
- Entity tables just need to track merges, not full version history

#### 2.2 Entity Merge Tracking (First-Class)

**Goal**: Make entity merges explicit and auditable

**Current Problem**: When Registrar merges "Dexter's ex-wife" into "Judy Dor", the merge is implicit (just updates aliases). No record of the decision.

**Solution**: Create explicit merge table

**Design Decision**: `entity_merges` is **mutable and deletable**. To undo a merge, simply delete the record and clear the `superseded_by` column on the source entity. Provenance for identity-based merges is preserved in the immutable `claims` table. For non-identity merges (fuzzy match, manual), event logs can capture deletions with the original reason if audit trail is needed.

```sql
CREATE TABLE entity_merges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id),

  -- Polymorphic source entity (the one being merged away)
  source_entity_id UUID NOT NULL,
  source_entity_type VARCHAR(50) NOT NULL, -- 'person', 'place', 'event', 'story'

  -- Polymorphic target entity (the one kept)
  target_entity_id UUID NOT NULL,
  target_entity_type VARCHAR(50) NOT NULL,

  -- Merge metadata
  merge_strategy VARCHAR(50), -- 'fuzzy_match', 'identity_claim', 'manual', 'llm_resolved'
  confidence DECIMAL(3,2), -- 0.00 to 1.00
  -- trigger_event_id uses simple FK to avoid overhead on high-volume conversation_events table
  -- Tenant safety is enforced by trigger below (not composite FK)
  trigger_event_id UUID REFERENCES conversation_events(id),

  -- Provenance
  merged_by VARCHAR(50), -- 'registrar', 'curator', 'admin', 'llm_resolver'
  merge_reason TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),

  -- Note: 'relationship' is intentionally excluded - relationships are edges, not mergeable nodes
  -- Claims can reference relationships via claim_entities, but relationships themselves aren't merged
  CONSTRAINT valid_entity_types CHECK (
    source_entity_type IN ('person', 'place', 'event', 'story') AND
    target_entity_type IN ('person', 'place', 'event', 'story')
  ),
  CONSTRAINT same_entity_type CHECK (source_entity_type = target_entity_type),
  -- Prevent self-merges
  CONSTRAINT no_self_merge CHECK (source_entity_id <> target_entity_id)
);

-- Only one active merge per source entity
-- Prevents ambiguous state where A→B and A→C both exist
CREATE UNIQUE INDEX idx_entity_merges_unique_source
  ON entity_merges(family_id, source_entity_type, source_entity_id);

CREATE INDEX idx_entity_merges_source
  ON entity_merges(family_id, source_entity_type, source_entity_id);

CREATE INDEX idx_entity_merges_target
  ON entity_merges(family_id, target_entity_type, target_entity_id);

-- Prevent circular merges (A→B→C→A)
-- IMPORTANT: Traverses entity_merges NOT denormalized superseded_by columns
-- This ensures cycle detection is consistent even if superseded_by is temporarily out of sync
CREATE OR REPLACE FUNCTION prevent_circular_merges()
RETURNS TRIGGER AS $$
BEGIN
  -- Check if target entity is already in the merge chain leading to source
  -- This prevents cycles like A→B→C→A
  IF EXISTS (
    WITH RECURSIVE merge_chain AS (
      -- Start from the target entity
      SELECT NEW.target_entity_id as entity_id, 1 as depth
      UNION ALL
      -- Follow the merge chain: find where this entity was merged TO
      SELECT em.target_entity_id, mc.depth + 1
      FROM entity_merges em
      JOIN merge_chain mc ON em.source_entity_id = mc.entity_id
      WHERE em.family_id = NEW.family_id  -- CRITICAL: scope to same tenant
        AND em.source_entity_type = NEW.source_entity_type
        AND mc.depth < 100  -- Depth limit for safety
    )
    SELECT 1 FROM merge_chain WHERE entity_id = NEW.source_entity_id
  ) THEN
    RAISE EXCEPTION 'Circular merge detected: would create cycle in % merge chain', NEW.source_entity_type;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_circular_merges
  BEFORE INSERT ON entity_merges
  FOR EACH ROW
  EXECUTE FUNCTION prevent_circular_merges();

-- Enforce tenant integrity for trigger_event_id without composite FK overhead
-- (Avoids adding UNIQUE(family_id, id) to high-volume conversation_events table)
CREATE OR REPLACE FUNCTION validate_entity_merge_trigger_event()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.trigger_event_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM conversation_events
      WHERE id = NEW.trigger_event_id AND family_id = NEW.family_id
    ) THEN
      RAISE EXCEPTION 'trigger_event_id must reference an event in the same family';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_entity_merge_trigger_event
  BEFORE INSERT OR UPDATE ON entity_merges
  FOR EACH ROW
  EXECUTE FUNCTION validate_entity_merge_trigger_event();
```

**Active Merges**: This table tracks currently active merges. The `superseded_by` columns on entity tables are denormalized copies for query performance. To undo a merge, delete the record and clear `superseded_by`.

**Workflow**:

1. Scribe produces identity claim: "Dexter's ex-wife" = "Judy Dor"
2. Registrar:
   - Finds person A (name: "Dexter's ex-wife")
   - Finds person B (name: "Judy Dor")
   - Creates entity_merge record (source: A, target: B, strategy: 'identity_claim')
   - Updates person B: adds "Dexter's ex-wife" to aliases
   - Marks person A as superseded_by = B
3. All claims that pointed to person A now findable via entity_merges table

**Benefits**:

- Explicit record of active merges with reason and confidence
- Can undo merges by deleting record (provenance preserved in claims)
- Can query "what entities were merged into this person?"
- Simple model - no status workflow, just exists or doesn't
- Supports LLM-based entity resolution (future)

#### 2.2.1 Querying Claims for Superseded Entities

**Problem**: When entity A is merged into entity B, claims in `claim_entities` still reference A's ID. How do we find "all claims about B" including claims originally about A?

**Solution**: Query helper that follows merge chains using `entity_merges`

```sql
-- Helper function: Get all entity IDs in merge chain (entity + all merged predecessors)
-- Uses entity_merges table NOT denormalized superseded_by columns
-- This ensures consistency even if superseded_by columns are temporarily out of sync
-- Supports all mergeable entity types: person, place, event, story
CREATE OR REPLACE FUNCTION get_entity_merge_chain(
  p_entity_id UUID,
  p_entity_type VARCHAR(50),  -- 'person', 'place', 'event', 'story'
  p_family_id UUID  -- Required for tenant scoping
) RETURNS TABLE(entity_id UUID) AS $$
BEGIN
  RETURN QUERY
  WITH RECURSIVE merge_chain AS (
    -- Start with the target entity
    SELECT p_entity_id as id, 1 as depth
    UNION ALL
    -- Find all entities that were merged INTO the current chain
    -- (i.e., source entities whose target is in our chain)
    SELECT em.source_entity_id, mc.depth + 1
    FROM entity_merges em
    JOIN merge_chain mc ON em.target_entity_id = mc.id
    WHERE em.family_id = p_family_id
      AND em.source_entity_type = p_entity_type
      AND em.target_entity_type = p_entity_type  -- Defensive: both types must match
      AND mc.depth < 100  -- Depth limit for safety (matches cycle prevention)
  )
  SELECT id FROM merge_chain;
END;
$$ LANGUAGE plpgsql STABLE;

-- Usage: Find all claims about a person (including claims about merged predecessors)
SELECT DISTINCT c.*
FROM claims c
JOIN claim_entities ce ON c.family_id = ce.family_id AND c.id = ce.claim_id
WHERE c.family_id = 'family-uuid-here'
  AND ce.entity_type = 'person'
  AND ce.entity_id IN (
    SELECT entity_id FROM get_entity_merge_chain('person-uuid-here', 'person', 'family-uuid-here')
  );
```

**Repository Helper** (TypeScript):

```typescript
// In ClaimEntityRepository
async findClaimsForEntityIncludingMerged(
  familyId: string,
  entityId: string,
  entityType: string
): Promise<Claim[]> {
  // Get all entity IDs in the merge chain (predecessors that were merged into this entity)
  const { data: entityIds } = await this.supabase.rpc('get_entity_merge_chain', {
    p_entity_id: entityId,
    p_entity_type: entityType,
    p_family_id: familyId,
  });

  // Query claims linked to any entity in the chain
  const { data: claims } = await this.supabase
    .from('claim_entities')
    .select('claims(*)')
    .eq('family_id', familyId)
    .eq('entity_type', entityType)
    .in('entity_id', entityIds);

  return claims?.map(ce => ce.claims) ?? [];
}
```

**Design Decision**: Claims keep their original entity references (preserves provenance). Queries use merge chain lookup to find all related claims. This ensures:

- Historical accuracy: "This claim was originally about 'Dexter's ex-wife'"
- No data loss on merge
- Reversible: If merge is undone, claims still point to correct entities

#### 2.3 Enable Multi-Entity Claims (Many-to-Many Relationship)

**Goal**: Allow claims to reference multiple entities with proper provenance and efficient bidirectional lookup

**Current Problem**: Claims have single (entity_id, entity_type) reference. But many claims involve multiple entities:

- "Maria married José in 1920" involves 2 people + 1 relationship
- "The family moved from Porto to São Paulo" involves 2 places + multiple people

**Solution**: Create claim_entities join table for many-to-many relationship

```sql
-- First, add composite unique constraint to claims for FK reference
-- (Add this to claims table migration)
ALTER TABLE claims ADD CONSTRAINT uq_claims_family_id UNIQUE (family_id, id);

CREATE TABLE claim_entities (
  family_id UUID NOT NULL,
  claim_id UUID NOT NULL,
  entity_id UUID NOT NULL,
  -- Note: includes 'relationship' since claims can be about relationships (e.g., "they were married")
  -- This differs from entity_merges which excludes relationships (edges aren't merged)
  entity_type VARCHAR(50) NOT NULL,  -- 'person', 'place', 'event', 'story', 'relationship'

  -- Metadata per entity-claim link
  role VARCHAR(50),                   -- 'subject', 'related', 'location', 'witness', 'mentioned'
  significance VARCHAR(20),           -- 'primary', 'secondary', 'mentioned'

  created_at TIMESTAMPTZ DEFAULT NOW(),

  -- PK starts with family_id for tenant partitioning
  PRIMARY KEY (family_id, claim_id, entity_id, entity_type),

  -- Composite FK enforces tenant integrity at DB level (family_id must match)
  CONSTRAINT fk_claim_entities_claim
    FOREIGN KEY (family_id, claim_id) REFERENCES claims(family_id, id) ON DELETE CASCADE,

  CONSTRAINT valid_entity_types CHECK (
    entity_type IN ('person', 'place', 'event', 'story', 'relationship')
  )
);

-- Index for family-scoped queries
CREATE INDEX idx_claim_entities_family
  ON claim_entities(family_id);

CREATE INDEX idx_claim_entities_entity
  ON claim_entities(family_id, entity_type, entity_id);

CREATE INDEX idx_claim_entities_claim
  ON claim_entities(family_id, claim_id);

-- Note: Minimum cardinality (at least one entity per claim) is enforced at the application
-- layer in Registrar when creating claims, not via database constraints. A unique index
-- cannot enforce minimum cardinality - it only ensures uniqueness.

-- IMPORTANT: Entity existence is NOT enforced by FK because entity_id is polymorphic
-- (references different tables based on entity_type). The DB guarantees:
--   1. Tenant integrity (family_id matches parent claim)
--   2. Claim existence (composite FK to claims)
-- The Registrar is responsible for ensuring entity_id references a valid entity.
```

**Example usage**:

```sql
-- Claim: "Maria married José in 1920"
INSERT INTO claims (family_id, claim_type, subject, claim_value, ...) VALUES (family_uuid, ...);  -- claim_id = X
INSERT INTO claim_entities (family_id, claim_id, entity_id, entity_type, role, significance) VALUES
  (family_uuid, X, maria_id, 'person', 'subject', 'primary'),
  (family_uuid, X, jose_id, 'person', 'related', 'primary'),
  (family_uuid, X, relationship_id, 'relationship', 'subject', 'primary');
```

**Data Migration**: After creating `claim_entities`, migrate existing `claims.entity_id`/`claims.entity_type` data. See the migration script in "Phase 5: Convert Arrays to Join Tables" section.

**Benefits**:

- Clean many-to-many relationship between claims and entities
- Efficient reverse queries: "show all claims about Maria" (single index lookup)
- Can add role-specific metadata (witness vs subject vs mentioned)
- Enables citation generation: "show all sources for this person"
- Supports "show your work" transparency
- Fast entity confidence calculations from supporting claims

#### 2.4 Elevate Identity Claims to First-Class

**Goal**: Make identity resolution explicit in schema

**Current**: Identity claims are just claim_type='identity' with special handling in Registrar

**Solution**: Create dedicated identity_claims table

**Note**: Identity claims are exclusively for people (not places/events), so no entity_type field needed

```sql
CREATE TABLE identity_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id),
  claim_id UUID NOT NULL,

  -- Descriptive reference (e.g., "Dexter's ex-wife")
  descriptive_name VARCHAR(255) NOT NULL,
  descriptive_person_id UUID,  -- If entity exists with this name

  -- Real identity (e.g., "Judy Dor")
  -- Nullable: may not be known initially (e.g., "Dexter's ex-wife" with no canonical name yet)
  canonical_name VARCHAR(255),
  canonical_person_id UUID,  -- If entity exists with this name

  -- Resolution status
  resolved BOOLEAN DEFAULT FALSE,
  resolved_at TIMESTAMPTZ,
  resolved_by VARCHAR(255),

  -- Link to merge decision (NULL if no merge needed, or merge was deleted)
  -- ON DELETE SET NULL: when a merge is deleted, this becomes NULL and resolved should be set to FALSE
  entity_merge_id UUID REFERENCES entity_merges(id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ DEFAULT NOW(),

  -- Composite FK enforces tenant integrity (claim must belong to same family)
  CONSTRAINT fk_identity_claims_claim
    FOREIGN KEY (family_id, claim_id) REFERENCES claims(family_id, id),

  -- Composite FKs enforce tenant integrity for person references
  -- (Uses UNIQUE (family_id, id) from people table added in migration)
  CONSTRAINT fk_identity_claims_descriptive_person
    FOREIGN KEY (family_id, descriptive_person_id) REFERENCES people(family_id, id),
  CONSTRAINT fk_identity_claims_canonical_person
    FOREIGN KEY (family_id, canonical_person_id) REFERENCES people(family_id, id),

  CONSTRAINT uq_identity_claim_per_claim UNIQUE (family_id, claim_id)
);

CREATE INDEX idx_identity_claims_descriptive
  ON identity_claims(family_id, descriptive_name);

CREATE INDEX idx_identity_claims_canonical
  ON identity_claims(family_id, canonical_name)
  WHERE canonical_name IS NOT NULL;

CREATE INDEX idx_identity_claims_unresolved
  ON identity_claims(family_id, resolved)
  WHERE resolved = FALSE;

-- Validate that claim_id references a claim with claim_type='identity' in same tenant
CREATE OR REPLACE FUNCTION validate_identity_claim_type()
RETURNS TRIGGER AS $$
BEGIN
  -- Use composite key lookup for tenant-scoped validation
  IF NOT EXISTS (
    SELECT 1 FROM claims
    WHERE family_id = NEW.family_id
      AND id = NEW.claim_id
      AND claim_type = 'identity'
  ) THEN
    RAISE EXCEPTION 'identity_claims.claim_id must reference a claim with claim_type=identity in same family';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_identity_claim_type
  BEFORE INSERT OR UPDATE ON identity_claims
  FOR EACH ROW EXECUTE FUNCTION validate_identity_claim_type();
```

**Workflow**:

1. Scribe outputs identity claim in domain model
2. Registrar creates claim record (regular claims table)
3. Registrar creates identity_claims record
4. Registrar resolves identity → creates entity_merge
5. Updates identity_claims.resolved = TRUE, entity_merge_id = X

**Benefits**:

- Clear separation of identity resolution from other claim types
- Easy to query "unresolved identities needing review"
- Explicit link between identity claim → merge decision
- Supports manual review workflow

---

### Phase 3: Knowledge Graph Preparation

#### 3.1 Add Graph-Ready Metadata to Entities

**Goal**: Prepare entities for Neo4j/KG export

**Changes**:

```sql
-- Add graph labels/tags to people
ALTER TABLE people
  ADD COLUMN graph_labels TEXT[], -- ['Person', 'Ancestor', 'Immigrant']
  ADD COLUMN graph_properties JSONB; -- Flexible key-value for graph

-- Add temporal bounds to relationships
ALTER TABLE relationships
  ADD COLUMN start_year INTEGER,
  ADD COLUMN start_year_approximate BOOLEAN DEFAULT FALSE,
  ADD COLUMN end_year INTEGER,
  ADD COLUMN end_year_approximate BOOLEAN DEFAULT FALSE;

-- Add graph clustering (using join table, not arrays, for consistency with other entity relationships)
CREATE TABLE entity_clusters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id),
  cluster_name VARCHAR(255) NOT NULL,
  cluster_type VARCHAR(50), -- 'family_branch', 'location_group', 'time_period', 'story_arc'
  description TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by VARCHAR(50), -- 'llm_clustering', 'manual', 'algorithm'

  -- Composite unique for FK reference from entity_cluster_members
  CONSTRAINT uq_entity_clusters_family_id UNIQUE (family_id, id)
);

CREATE INDEX idx_entity_clusters_family_type
  ON entity_clusters(family_id, cluster_type);

-- Join table for cluster membership (consistent with other entity relationships)
CREATE TABLE entity_cluster_members (
  family_id UUID NOT NULL,
  cluster_id UUID NOT NULL,
  entity_id UUID NOT NULL,
  entity_type VARCHAR(50) NOT NULL, -- 'person', 'place', 'event'

  -- Optional metadata per membership
  role VARCHAR(50),            -- e.g., 'central_figure', 'peripheral'
  added_at TIMESTAMPTZ DEFAULT NOW(),

  PRIMARY KEY (family_id, cluster_id, entity_id, entity_type),

  -- Composite FK enforces tenant integrity at DB level
  CONSTRAINT fk_entity_cluster_members_cluster
    FOREIGN KEY (family_id, cluster_id) REFERENCES entity_clusters(family_id, id) ON DELETE CASCADE,

  CONSTRAINT valid_entity_types CHECK (
    entity_type IN ('person', 'place', 'event')
  )
);

CREATE INDEX idx_entity_cluster_members_family
  ON entity_cluster_members(family_id);

CREATE INDEX idx_entity_cluster_members_entity
  ON entity_cluster_members(family_id, entity_type, entity_id);

CREATE INDEX idx_entity_cluster_members_cluster
  ON entity_cluster_members(family_id, cluster_id);
```

**Benefits**:

- Can export to Neo4j with proper labels
- Temporal relationship bounds enable "show family tree in 1920"
- Clustering supports community detection for book chapters
- graph_properties allows arbitrary metadata without schema changes

#### 3.2 Add GEDCOM Export Support

**Goal**: Enable export to standard genealogy format

**Changes**:

```sql
CREATE TABLE gedcom_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id),

  entity_type VARCHAR(50) NOT NULL,
  entity_id UUID NOT NULL,

  gedcom_id VARCHAR(50) NOT NULL, -- e.g., @I1@, @F1@
  gedcom_type VARCHAR(20) NOT NULL, -- 'INDI', 'FAM', 'PLAC'

  last_export_at TIMESTAMPTZ,

  UNIQUE(family_id, entity_type, entity_id),
  UNIQUE(family_id, gedcom_id)
);
```

**Benefits**:

- Can export family tree to Family Tree Maker, Ancestry.com, etc.
- Stable IDs enable incremental export
- Interoperability with genealogy ecosystem

#### 3.3 Prepare for Neo4j Hybrid Architecture

**From entity-resolution-architecture.md**: Neo4j for people/relationships, Supabase for claims/stories

**Decision Point**: Not implementing now, but preparing the schema

**Preparation**:

1. Ensure all entity IDs are UUIDs (already done ✓)
2. Add sync metadata for eventual Neo4j writes:

```sql
ALTER TABLE people
  ADD COLUMN neo4j_synced_at TIMESTAMPTZ,
  ADD COLUMN neo4j_sync_version INTEGER DEFAULT 0;

ALTER TABLE relationships
  ADD COLUMN neo4j_synced_at TIMESTAMPTZ,
  ADD COLUMN neo4j_sync_version INTEGER DEFAULT 0;
```

3. When ready to adopt Neo4j:
   - Registrar writes to both Postgres + Neo4j atomically
   - Use sync_version for consistency checking
   - Queries route to appropriate DB (relationships → Neo4j, claims → Postgres)

---

## Optimal Claims Table Strategy

### Current State

- Claims are atomic facts with source_event_id provenance ✓
- Claims have polymorphic entity links via (entity_id, entity_type) ✓
- Conflicts preserved in claim_conflicts table ✓

### Enhancements

#### 1. Add Claim Chains (Supporting/Contradicting)

**Goal**: Track how claims build on or contradict each other

```sql
CREATE TABLE claim_relationships (
  family_id UUID NOT NULL REFERENCES families(id),
  claim_id UUID NOT NULL,
  related_claim_id UUID NOT NULL,
  -- 'supports', 'contradicts', 'refines', 'supersedes', 'derived_from'
  relationship_type VARCHAR(50) NOT NULL,

  created_at TIMESTAMPTZ DEFAULT NOW(),

  PRIMARY KEY (family_id, claim_id, related_claim_id, relationship_type),

  -- Composite FKs enforce tenant integrity (both claims must belong to same family)
  CONSTRAINT fk_claim_relationships_claim
    FOREIGN KEY (family_id, claim_id) REFERENCES claims(family_id, id),
  CONSTRAINT fk_claim_relationships_related
    FOREIGN KEY (family_id, related_claim_id) REFERENCES claims(family_id, id),

  CONSTRAINT no_self_relation CHECK (claim_id != related_claim_id)
);

CREATE INDEX idx_claim_relationships_claim
  ON claim_relationships(family_id, claim_id);

-- Reverse lookup: "find claims that support/contradict this claim"
CREATE INDEX idx_claim_relationships_related
  ON claim_relationships(family_id, related_claim_id);
```

**Benefits**:

- Can build argument graphs for fact-checking
- "Show me all evidence for/against this date"
- Supports LLM reasoning over claims

#### 2. Add Claim Derivations (Inferred Claims)

**Goal**: Track when claims are inferred vs directly stated

```sql
-- Derivations are modeled as claim_relationships with type='derived_from'
-- (consistent with supports/contradicts/refines/supersedes pattern)
-- See claim_relationships table above

ALTER TABLE claims
  ADD COLUMN inference_method VARCHAR(50); -- 'direct', 'logical_inference', 'llm_inference'
```

**Example**:

- Direct claim: "Maria married José in 1920"
- Inferred claim: "Maria's last name changed to José's last name"
  - `inference_method = 'logical_inference'`
  - Plus: `INSERT INTO claim_relationships (family_id, claim_id, related_claim_id, relationship_type) VALUES (family_uuid, inferred_claim_id, marriage_claim_id, 'derived_from')`

**Benefits**:

- Consistent pattern: all claim-to-claim links go through claim_relationships
- Distinguish facts from inferences via inference_method column
- Can show inference chains via claim_relationships
- Enables explainable AI reasoning

#### 3. Add Claim Strength/Weight

**Goal**: Not all claims are equal

```sql
ALTER TABLE claims
  ADD COLUMN claim_strength DECIMAL(3,2) DEFAULT 0.50, -- 0.00 to 1.00
  ADD COLUMN strength_factors JSONB, -- Complete breakdown for auditability
  ADD COLUMN needs_llm_evaluation BOOLEAN DEFAULT FALSE,
  ADD COLUMN llm_evaluated_at TIMESTAMPTZ,
  -- Lock/lease mechanism to prevent duplicate LLM evaluation by concurrent workers
  ADD COLUMN llm_eval_locked_at TIMESTAMPTZ,
  ADD COLUMN llm_eval_locked_by TEXT,
  -- Retry tracking for backoff and debugging
  ADD COLUMN llm_eval_attempts INTEGER DEFAULT 0,
  ADD COLUMN llm_eval_last_error TEXT;

-- Index for efficient queue polling
CREATE INDEX idx_claims_llm_pending
  ON claims(family_id, created_at)
  WHERE needs_llm_evaluation = TRUE AND llm_evaluated_at IS NULL;
```

**Strength Calculation: Hybrid Automatic + Selective LLM Enhancement**

**Approach**: Cost-optimized hybrid that keeps 90-95% of claims free while using LLM intelligence where it matters most.

**Phase 1 - Algorithmic Scoring (all claims, $0 cost)**:

```
base_score = {
  direct: 1.0,
  attributed: 0.8,
  hearsay: 0.5
}

certainty_modifier = {
  "definitely/certainly": 1.0,
  "probably": 0.9,
  "I think/maybe": 0.7,
  "might/could": 0.6
}

conflict_penalty = 0.8 per conflicting claim (multiplicative)
confirmation_boost = 1.1 per supporting claim (multiplicative, cap at 1.0)

algorithmic_score = base_score * certainty_modifier * conflict_penalty * confirmation_boost
```

**Phase 2 - LLM Evaluation (5-10% of claims, selective cost)**:

Trigger LLM evaluation when:

- `hasConflicts` - Competing claims exist
- `certainty_language` contains "think/maybe/probably"
- `claimed_by_source === 'hearsay'`
- `isHighStakes` - Death/birth dates, legal relationships
- `algorithmic_score < 0.6` - Low initial confidence

**Phase 3 - Blending**:

- If LLM evaluated: `final_score = (algorithmic_score * 0.4) + (llm_score * 0.6)`
- If not evaluated: `final_score = algorithmic_score`

**strength_factors JSONB structure**:

```json
{
  "algorithm_score": 0.7,
  "breakdown": {
    "source_type": 1.0,
    "conflict_penalty": 0.8,
    "recency": 0.95,
    "certainty_factor": 0.9
  },
  "llm_score": 0.85,
  "llm_reasoning": "Despite being hearsay, the specific detail about the ship name suggests high reliability",
  "final": 0.775,
  "evaluation_triggered": ["hasConflicts", "hearsay"]
}
```

**Benefits**:

- **Cost-efficient**: 90-95% of claims scored algorithmically ($0), LLM only for complex cases
- **Auditable**: Complete breakdown stored in strength_factors
- **Context-aware**: LLM evaluates nuanced cases with full conversation context
- **Consistent**: Algorithmic scoring provides baseline, LLM adds intelligence
- **Transparent**: Can show exactly how each score was calculated

**Example Scenarios**:

1. Simple claim ("Maria married José in 1920", direct, no conflicts) → Algorithm: 1.0, Cost: $0
2. Conflicting claims ("arrived 1889" vs "arrived 1891") → Algorithm: 0.7-0.8, LLM evaluates both → Final: 0.85 vs 0.65, Cost: 2 LLM calls
3. Hearsay with detail ("came on ship 'Galicia' in 1889", hearsay) → Algorithm: 0.6, LLM recognizes specific detail → Final: 0.75, Cost: 1 LLM call

#### 4. LLM Evaluation Queue Mechanism

**Goal**: Define how claims are queued and processed for LLM evaluation

**Approach**: Flag-based polling using existing columns (no separate queue table)

**Implementation**:

- `needs_llm_evaluation BOOLEAN DEFAULT FALSE` - Set by Registrar when criteria met
- `llm_evaluated_at TIMESTAMPTZ` - Set when LLM evaluation completes
- `llm_eval_locked_at TIMESTAMPTZ` - Lock timestamp for concurrent worker safety
- `llm_eval_locked_by TEXT` - Worker ID holding the lock
- `llm_eval_attempts INTEGER DEFAULT 0` - Retry counter for backoff
- `llm_eval_last_error TEXT` - Last error message for debugging
- A background worker (cron job or serverless function) polls for pending evaluations

**Queue Query with Locking** (prevents duplicate processing):

```sql
-- Note: claims.status is an existing column with values:
--   'active' (default), 'superseded', 'disputed', 'redacted'
-- Only evaluate active claims (not superseded/redacted)

-- Atomically claim and lock records for LLM evaluation
-- Worker ID is passed as parameter $1 - same ID for entire batch
-- Uses FOR UPDATE SKIP LOCKED to prevent concurrent workers from grabbing same rows
UPDATE claims
SET llm_eval_locked_at = NOW(),
    llm_eval_locked_by = $1,  -- Worker ID passed as parameter
    llm_eval_attempts = llm_eval_attempts + 1
WHERE id IN (
  SELECT c.id
  FROM claims c
  WHERE c.needs_llm_evaluation = TRUE
    AND c.llm_evaluated_at IS NULL
    AND c.status = 'active'  -- Only evaluate active claims
    -- Not locked, or lock expired (stale lock after 15 min)
    AND (c.llm_eval_locked_at IS NULL
         OR c.llm_eval_locked_at < NOW() - INTERVAL '15 minutes')
    -- Backoff: skip claims that have failed too many times recently
    AND c.llm_eval_attempts < 5
  ORDER BY c.created_at ASC
  LIMIT 10
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

**Worker Process** (pseudocode):

```typescript
// Run every 5 minutes via cron or triggered after ingestion batch completes
async function processLLMEvaluationQueue() {
  // Generate worker ID once per batch (same ID for all rows in this run)
  const workerId = `worker-${hostname()}-${process.pid}-${Date.now()}`;

  // Atomically claim a batch of claims with locking (passes workerId to query)
  const claimedRows = await claimRepository.claimForEvaluation(workerId, 10);

  for (const claim of claimedRows) {
    try {
      // Get related context: conflicting claims, supporting claims, source conversation
      const conflicts = await claimRepository.findConflicting(claim.id);
      const sourceEvent = await conversationEventRepository.findById(
        claim.sourceEventId,
      );

      // Build prompt with full context
      const prompt = buildEvaluationPrompt(claim, conflicts, sourceEvent);

      // Call LLM (e.g., Claude) for evaluation
      const llmResult = await evaluateClaimWithLLM(prompt);

      // Update claim with LLM results and release lock
      await claimRepository.update(claim.id, {
        claim_strength: blendScores(claim.claim_strength, llmResult.score),
        strength_factors: {
          ...claim.strength_factors,
          llm_score: llmResult.score,
          llm_reasoning: llmResult.reasoning,
          final: blendScores(claim.claim_strength, llmResult.score),
        },
        llm_evaluated_at: new Date(),
        llm_eval_locked_at: null, // Release lock
        llm_eval_locked_by: null,
        llm_eval_last_error: null, // Clear error on success
      });
    } catch (error) {
      // On error, release lock and record error for debugging
      await claimRepository.update(claim.id, {
        llm_eval_locked_at: null,
        llm_eval_locked_by: null,
        llm_eval_last_error: error.message,
        // llm_eval_attempts already incremented in claim query
      });
      console.error(`Failed to evaluate claim ${claim.id}:`, error);
    }
  }
}
```

**Triggering Evaluation**:

1. **Immediate**: Registrar sets `needs_llm_evaluation = TRUE` during claim creation
2. **Deferred**: Background worker picks up flagged claims
3. **On-demand**: When a user views a claim detail page, trigger evaluation if needed

**Benefits**:

- No additional queue infrastructure needed (just SQL queries)
- Idempotent - can re-run safely if interrupted
- Batched processing reduces LLM API calls
- Clear audit trail via `llm_evaluated_at` timestamp

---

## Data Flow & Entities

### Core Entities (Current + Enhanced)

1. **Person**
   - Current fields ✓
   - \+ superseded_by, superseded_at (merge tracking; merge_reason on entity_merges)
   - \+ graph_labels, graph_properties (for future Neo4j export)
   - \+ neo4j_synced_at (for future Neo4j sync)

2. **Place**
   - Current fields ✓
   - \+ superseded_by, superseded_at (merge tracking; merge_reason on entity_merges)
   - \+ graph_labels, graph_properties

3. **TimelineEvent** (events table)
   - Current fields ✓
   - \+ superseded_by, superseded_at (merge tracking; merge_reason on entity_merges)
   - \+ event_participants table (explicit, not array)

4. **Relationship**
   - Current fields ✓
   - \+ start_year, end_year (temporal bounds for graph queries)
   - \+ neo4j_synced_at

5. **Story**
   - Current fields ✓
   - \+ superseded_by, superseded_at (stories can be enriched/merged over time)

6. **Claim** (enhanced)
   - Current fields ✓
   - \+ inference_method (track inferred claims; derivations via claim_relationships)
   - \+ claim_strength, strength_factors, needs_llm_evaluation, llm_evaluated_at (hybrid scoring)
   - Make entity_id, entity_type nullable (legacy fields, use claim_entities join table instead)

### New Entities

7. **EntityMerge**
   - Tracks active entity merges (mutable, deletable)
   - Delete to undo merge; provenance preserved in claims
   - Links source entity → target entity with confidence and reason

8. **IdentityClaim**
   - First-class identity resolution for people
   - Links descriptive → canonical names (e.g., "Dexter's ex-wife" → "Judy Dor")
   - Tracks resolution status and merge decision

9. **ClaimEntities** (join table)
   - Many-to-many relationship between claims and entities
   - Enables claims to reference multiple entities
   - Fast bidirectional lookup (claim → entities, entity → claims)
   - Includes role and significance metadata per link

10. **IngestionBatch** (batch operations only)
    - Groups conversation_events for bulk/manual imports and cron jobs
    - **NOT** used for real-time Telegram polling (messages processed individually)
    - Enables rollback for batch imports
    - Tracks ingestion health for scheduled jobs

11. **ClaimRelationship**
    - Links claims that support/contradict each other
    - Builds argument graphs for reasoning
    - Enables "show evidence for/against" queries

12. **EntityCluster** + **EntityClusterMembers** (join table)
    - Groups related entities (family branches, location groups, time periods)
    - Supports book chapter generation
    - Can be LLM-generated or manual
    - Uses join table (not arrays) for consistency with other entity relationships

13. **StoryEntities** (join table)
    - Many-to-many relationship between stories and entities
    - Replaces array-based storage
    - Includes role and significance metadata

14. **EventParticipants** (join table)
    - Many-to-many relationship between events and entities (people, places)
    - Replaces array-based storage
    - Polymorphic design supports location context for events

---

## Implementation Workflow

> **Note**: For detailed application-layer implementation (services, dependency injection, code structure), see [Chatbots App Changes](./2026-01-21-chatbots-app-data-architecture-changes.md).

### Scribe (Minor changes)

- Continues extracting to domain model
- Outputs identity claims as before
- **Minor additions**: `inferenceMethod`, `referencedPeople`, `referencedPlaces` on ExtractedClaim

### Registrar (Major enhancements - Service-Based Architecture)

Registrar becomes an **orchestrator** with extracted services. Business logic moves to testable services that use a shared DataRetrieverService.

**Architecture**:

```
Registrar (orchestrator)
    │
    ├── EntityMatcherService      # Entity matching logic
    ├── ConflictDetectorService   # Claim conflict detection
    ├── StrengthCalculatorService # Claim strength scoring
    └── MergeHandlerService       # Entity merge operations
              │
              ▼
       DataRetrieverService       # Shared retrieval (also used by Historian)
              │
              ▼
         Repositories             # CRUD operations
```

**Processing Flow**:

```
1. Process people (via EntityMatcherService)
   a. Get existing people context via DataRetrieverService
   b. Match via exact name, alias, fuzzy, or optional LLM verification
   c. If match found AND confidence >= threshold (>0.9):
      - Create entity_merge record via MergeHandlerService
      - Update target person (add source name to aliases)
      - Mark source person as superseded (superseded_by = target_id)
   d. If confidence requires review (0.7-0.9):
      - Do NOT create merge yet
      - Log potential match for manual review (future Curator agent)
   e. If low confidence (<0.7):
      - Create as separate entity, no merge

2. Process identity_claims
   a. Create claim record (in claims table)
   b. Create identity_claims record (descriptive name, canonical name)
   c. Resolve identity → create entity_merge via MergeHandlerService
   d. Mark identity_claim as resolved (resolved = TRUE, entity_merge_id)

3. Process places (via EntityMatcherService)
   a. Similar fuzzy matching and merge logic as people
   b. Match on name, city, country hierarchy

4. Process events (via EntityMatcherService)
   a. Similar fuzzy matching and merge logic
   b. Match on title, date, place, participants

5. Process claims (via ConflictDetectorService + StrengthCalculatorService)
   a. Create claim record
   b. Detect conflicts via ConflictDetectorService (uses DataRetrieverService)
   c. Calculate algorithmic claim_strength via StrengthCalculatorService
   d. Check if needs_llm_evaluation (conflicts, hearsay, low confidence)
   e. If needs LLM: queue for async evaluation
   f. Link claim to entities via claim_entities table
   g. Create claim_relationship entries for detected conflicts

6. Process relationships
   a. Create relationship record
   b. Infer temporal bounds from related events (birth/death/marriage dates)
   c. Link to Neo4j (future, when enabled)
```

### New: Curator Agent (Optional, future)

**Purpose**: Manual review and correction

**Capabilities**:

- Review unresolved identity_claims
- Create merges for medium-confidence matches
- Delete incorrect merges
- Manually link claims to entities
- Adjust claim strengths

---

## Verification Strategy

### Phase 1 Verification (conversation_events)

1. ✅ Check sequence_number is monotonically increasing per family
2. ✅ Check no duplicate (source, conversation_id, external_event_id) per family
3. ✅ Check batch-imported events have ingestion_batch_id (real-time messages may have NULL)
4. ✅ Run event replay: delete all entities, replay events in sequence order → should recreate identical state

### Phase 2 Verification (entity ingestion)

1. ✅ Check every entity has at least one entry in claim_entities (except placeholders)
2. ✅ Check every superseded entity has entity_merge record
3. ✅ Check identity_claims.resolved matches existence of entity_merge_id
4. ✅ Delete a merge → verify claims still queryable (original entity references preserved)
5. ✅ Check claim_strength calculations are consistent
6. ✅ Verify temporal history via claims: query claims at specific timestamp returns correct facts for that point in time
7. ✅ Check claim_entities bidirectional consistency: all claims have entities, all entity references are valid

### Phase 3 Verification (knowledge graph)

1. ✅ Export to GEDCOM → re-import → verify no data loss
2. ✅ Export people + relationships to Neo4j → run family tree queries → verify correct results
3. ✅ Check entity_clusters are non-overlapping (or explicitly allow overlap)

---

## Critical Files to Modify

| File                                                                        | Type   | Changes                                                                                                                                                                               |
| --------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/db/supabase/migrations/20260121000_enhance_conversation_events.sql`   | NEW    | Add sequence_number column, create family_sequence_counters table with atomic trigger, payload_version, metadata_version                                                              |
| `apps/db/supabase/migrations/20260121001_add_ingestion_batches.sql`         | NEW    | Create ingestion_batches table, add ingestion_batch_id FK to conversation_events                                                                                                      |
| `apps/db/supabase/migrations/20260121002_convert_arrays_to_join_tables.sql` | NEW    | Create story_entities, event_participants join tables; migrate data from arrays; validation queries                                                                                   |
| `apps/db/supabase/migrations/20260121003_add_entity_merge_tracking.sql`     | NEW    | Add superseded_by, superseded_at to people/places/events/stories (merge_reason on entity_merges only)                                                                                 |
| `apps/db/supabase/migrations/20260121004_add_entity_merges.sql`             | NEW    | Create entity_merges table with circular merge prevention trigger                                                                                                                     |
| `apps/db/supabase/migrations/20260121005_add_identity_claims.sql`           | NEW    | Create identity_claims table (people only, no entity_type field)                                                                                                                      |
| `apps/db/supabase/migrations/20260121006_add_claim_entities.sql`            | NEW    | Create claim_entities join table with entity_type constraint                                                                                                                          |
| `apps/db/supabase/migrations/20260121007_enhance_claims.sql`                | NEW    | Add inference_method, claim_strength, strength_factors, needs_llm_evaluation; make entity_id/entity_type nullable (derivations via claim_relationships)                               |
| `apps/db/supabase/migrations/20260121008_make_claims_immutable.sql`         | NEW    | Add immutability triggers for core claim data, prevent deletes                                                                                                                        |
| `apps/db/supabase/migrations/20260121009_add_claim_relationships.sql`       | NEW    | Create claim_relationships table (supports, contradicts, refines, supersedes, derived_from)                                                                                           |
| `apps/db/supabase/migrations/20260121010_add_graph_metadata.sql`            | NEW    | Add graph_labels, temporal bounds, entity_clusters + entity_cluster_members tables                                                                                                    |
| `apps/db/supabase/migrations/20260121011_add_merge_chain_helper.sql`        | NEW    | Create get_entity_merge_chain() function for querying claims across merged entities                                                                                                   |
| `libs/database/src/lib/repositories/entity-merge-repository.ts`             | NEW    | CRUD for entity_merges, merge/unmerge operations                                                                                                                                      |
| `libs/database/src/lib/repositories/identity-claim-repository.ts`           | NEW    | CRUD for identity_claims, resolution workflow                                                                                                                                         |
| `libs/database/src/lib/repositories/story-entity-repository.ts`             | NEW    | CRUD for story_entities join table                                                                                                                                                    |
| `libs/database/src/lib/repositories/event-participant-repository.ts`        | NEW    | CRUD for event_participants join table                                                                                                                                                |
| `libs/database/src/lib/repositories/claim-entity-repository.ts`             | NEW    | CRUD for claim_entities join table, bidirectional queries                                                                                                                             |
| `libs/database/src/lib/repositories/claim-relationship-repository.ts`       | NEW    | CRUD for claim_relationships                                                                                                                                                          |
| `libs/database/src/lib/repositories/ingestion-batch-repository.ts`          | NEW    | CRUD for ingestion_batches                                                                                                                                                            |
| `libs/database/src/lib/repositories/entity-cluster-repository.ts`           | NEW    | CRUD for entity_clusters and entity_cluster_members                                                                                                                                   |
| `libs/database/src/lib/services/data-retriever.ts`                          | NEW    | Shared retrieval layer used by Registrar services and Historian (see chatbots app plan)                                                                                               |
| `libs/database/src/lib/repositories/claim-repository.ts`                    | MODIFY | Add linkEntities(); remove calculateClaimStrength/detectConflicts (moved to services)                                                                                                 |
| `libs/database/src/lib/repositories/person-repository.ts`                   | MODIFY | Add markSuperseded(), getMergeChain()                                                                                                                                                 |
| `libs/database/src/lib/repositories/story-repository.ts`                    | MODIFY | Update to use story_entities join table instead of arrays                                                                                                                             |
| `libs/database/src/lib/repositories/timeline-event-repository.ts`           | MODIFY | Update to use event_participants join table (polymorphic), add markSuperseded()                                                                                                       |
| `libs/agents/registrar/src/lib/registrar.ts`                                | MODIFY | Refactor to orchestrator pattern using services (see chatbots app plan)                                                                                                               |
| `libs/agents/registrar/src/lib/services/entity-matcher.ts`                  | NEW    | Entity matching logic (exact, alias, fuzzy, optional LLM verification)                                                                                                                |
| `libs/agents/registrar/src/lib/services/conflict-detector.ts`               | NEW    | Claim conflict detection (value-based + optional semantic via LLM)                                                                                                                    |
| `libs/agents/registrar/src/lib/services/strength-calculator.ts`             | NEW    | Algorithmic claim strength calculation logic (hybrid approach)                                                                                                                        |
| `libs/agents/registrar/src/lib/services/merge-handler.ts`                   | NEW    | Entity merge and unmerge operations                                                                                                                                                   |
| `libs/agents/historian/src/lib/retriever.ts`                                | MODIFY | Use shared DataRetrieverService, move common logic there                                                                                                                              |
| `libs/shared/types/src/lib/entities.ts`                                     | MODIFY | Add EntityMerge, IdentityClaim, ClaimEntity, IngestionBatch, StoryEntity, EventParticipant, EntityCluster, EntityClusterMember types; add merge fields to Person, Place, Event, Story |
| `libs/shared/types/src/lib/claims.ts`                                       | MODIFY | Update Claim interface: add inference_method, claim_strength, strength_factors, needs_llm_evaluation; make entity_id/entity_type nullable (derivations via claim_relationships)       |
| `libs/shared/types/src/lib/domain-model.ts`                                 | MODIFY | Add inferenceMethod, referencedPeople, referencedPlaces to ExtractedClaim                                                                                                             |

---

## Risks & Mitigations

### Risk 1: Schema complexity

**Mitigation**: Implement in phases, extensive testing between phases

### Risk 2: Performance (many joins)

**Mitigation**: Strategic indexes on join tables (claim_entities, story_entities, event_participants), consider read replicas for heavy query workloads

### Risk 3: Data migration

**Mitigation**: All changes are additive (ADD COLUMN), no DROP or destructive changes

### Risk 4: Merge reversibility edge cases

**Mitigation**: Comprehensive test suite for merge/unmerge scenarios

---

## Architectural Questions & Decisions

### Q1: Should a claim be able to have > 1 source linked to it?

**Current Design:** Single `source_event_id` per claim

**Decision: KEEP SINGLE SOURCE, USE claim_relationships FOR CONFIRMATION**

**Rationale:**

- One source per claim maintains atomic provenance: "who said what when"
- Confirmations are modeled as separate claims with 'supports' relationship via claim_relationships
- Example:
  - Claim 1: "Maria born 1920" (source_event_id = msg_123, claimed_by = "João")
  - Claim 2: "Maria born 1920" (source_event_id = msg_456, claimed_by = "Ana")
  - claim_relationships: (claim_2, claim_1, 'supports')
- Inferred claims link to parents via `claim_relationships` with `type='derived_from'` (consistent with other claim links)

**Why not array of sources:**

- Arrays complicate "who said what" - need per-source metadata (certainty_language, claimed_by)
- Each source might phrase the claim differently (context_original)
- Aggregation happens via claim_relationships, not shared sources

**Implementation:**

- Keep single `source_event_id` for direct claims
- Use `claim_relationships` with `type='derived_from'` for inferred claims (consistent pattern)
- Use `claim_relationships` to link supporting/confirming claims

---

### Q2: Should we be using join tables instead of arrays?

**Decision: HYBRID APPROACH - JOIN TABLES FOR STRUCTURED RELATIONSHIPS, ARRAYS FOR SIMPLE LISTS**

**Current arrays to KEEP:**

- `people.aliases` (JSONB) - Simple strings, no metadata needed, rarely queried reverse direction

Note: `derived_from_claim_ids` was removed in favor of `claim_relationships` with `type='derived_from'` for consistency.

**Current arrays to CONVERT TO JOIN TABLES:**

- `stories.people / places / events` → Create `story_entities` join table
- `events.people_involved` → Create `event_participants` join table
- Reason: These need metadata (role, significance, confidence) and reverse queries are common

**Trade-offs:**

| Aspect            | Arrays                     | Join Tables              |
| ----------------- | -------------------------- | ------------------------ |
| Read performance  | Fast for small collections | Requires JOIN            |
| Write performance | Simple updates             | Insert to separate table |
| Metadata per item | Not possible               | Natural fit              |
| Reverse queries   | Requires array operators   | Natural with indexes     |
| Normalization     | Denormalized               | Normalized               |
| Schema evolution  | Hard to add metadata       | Easy to add columns      |

**Recommendation:**

- **Use arrays for:** Simple value lists (tags, keywords, aliases) with <50 items and no per-item metadata
- **Use join tables for:** Entity relationships, any case with per-item metadata, frequent reverse queries

**New migrations to add:**

```sql
-- Migration: 20260121002_convert_arrays_to_join_tables.sql

-- NOTE: Composite unique constraints on stories/events are already added in
-- the entity merge tracking migration. The constraints below are shown for
-- completeness but will be skipped if they already exist.
-- (In actual migration, use DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;)

CREATE TABLE story_entities (
  family_id UUID NOT NULL,
  story_id UUID NOT NULL,
  entity_id UUID NOT NULL,
  entity_type VARCHAR(50) NOT NULL,    -- 'person', 'place', 'event'
  role VARCHAR(100),                    -- 'protagonist', 'location', 'background'
  significance VARCHAR(20),             -- 'primary', 'secondary', 'mentioned'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (family_id, story_id, entity_id, entity_type),

  -- Composite FK enforces tenant integrity at DB level
  CONSTRAINT fk_story_entities_story
    FOREIGN KEY (family_id, story_id) REFERENCES stories(family_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_story_entities_family ON story_entities(family_id);
CREATE INDEX idx_story_entities_entity ON story_entities(family_id, entity_type, entity_id);

CREATE TABLE event_participants (
  family_id UUID NOT NULL,
  event_id UUID NOT NULL,
  entity_id UUID NOT NULL,
  entity_type VARCHAR(50) NOT NULL,     -- 'person', 'place' (events can have location context)
  role VARCHAR(100),                    -- 'organizer', 'attendee', 'speaker', 'mentioned', 'location'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (family_id, event_id, entity_id, entity_type),

  -- Composite FK enforces tenant integrity at DB level
  CONSTRAINT fk_event_participants_event
    FOREIGN KEY (family_id, event_id) REFERENCES events(family_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_event_participants_family ON event_participants(family_id);
CREATE INDEX idx_event_participants_entity ON event_participants(family_id, entity_type, entity_id);

-- ============================================
-- DATA MIGRATION SCRIPTS
-- Run these after creating tables, before dropping old columns
-- ============================================

-- Migrate stories.people array to story_entities
INSERT INTO story_entities (family_id, story_id, entity_id, entity_type, role, significance)
SELECT s.family_id, s.id, unnest(s.people), 'person', 'mentioned', 'secondary'
FROM stories s
WHERE s.people IS NOT NULL AND array_length(s.people, 1) > 0
ON CONFLICT DO NOTHING;

-- Migrate stories.places array to story_entities
INSERT INTO story_entities (family_id, story_id, entity_id, entity_type, role, significance)
SELECT s.family_id, s.id, unnest(s.places), 'place', 'location', 'secondary'
FROM stories s
WHERE s.places IS NOT NULL AND array_length(s.places, 1) > 0
ON CONFLICT DO NOTHING;

-- Migrate stories.events array to story_entities
INSERT INTO story_entities (family_id, story_id, entity_id, entity_type, role, significance)
SELECT s.family_id, s.id, unnest(s.events), 'event', 'mentioned', 'secondary'
FROM stories s
WHERE s.events IS NOT NULL AND array_length(s.events, 1) > 0
ON CONFLICT DO NOTHING;

-- Migrate events.people_involved array to event_participants
INSERT INTO event_participants (family_id, event_id, entity_id, entity_type, role)
SELECT e.family_id, e.id, unnest(e.people_involved), 'person', 'participant'
FROM events e
WHERE e.people_involved IS NOT NULL AND array_length(e.people_involved, 1) > 0
ON CONFLICT DO NOTHING;

-- NOTE: The claim_entities data migration below requires the claim_entities table to exist.
-- claim_entities is created in Phase 2.3 (see "Enable Multi-Entity Claims" section).
-- Ensure the claim_entities migration runs BEFORE this data migration script.
--
-- Migrate existing claims.(entity_id, entity_type) to claim_entities
-- This preserves the original single-entity references as primary entities
INSERT INTO claim_entities (family_id, claim_id, entity_id, entity_type, role, significance)
SELECT c.family_id, c.id, c.entity_id, c.entity_type, 'subject', 'primary'
FROM claims c
WHERE c.entity_id IS NOT NULL AND c.entity_type IS NOT NULL
ON CONFLICT DO NOTHING;

-- ============================================
-- VALIDATION QUERIES (run before dropping old columns)
-- ============================================

-- Verify story_entities migration completeness
-- SELECT COUNT(*) as stories_with_people FROM stories WHERE people IS NOT NULL AND array_length(people, 1) > 0;
-- SELECT COUNT(DISTINCT story_id) as migrated FROM story_entities WHERE entity_type = 'person';

-- Verify event_participants migration completeness
-- SELECT COUNT(*) as events_with_people FROM events WHERE people_involved IS NOT NULL AND array_length(people_involved, 1) > 0;
-- SELECT COUNT(DISTINCT event_id) as migrated FROM event_participants WHERE entity_type = 'person';

-- ============================================
-- DROP OLD COLUMNS (only after validation passes)
-- ============================================
-- ALTER TABLE stories DROP COLUMN people;
-- ALTER TABLE stories DROP COLUMN places;
-- ALTER TABLE stories DROP COLUMN events;
-- ALTER TABLE events DROP COLUMN people_involved;
-- Note: Keep claims.entity_id and claims.entity_type as nullable for backwards compatibility
-- They are now deprecated in favor of claim_entities but not removed
```

---

### Q3: Should the claims table be immutable?

**Decision: IMMUTABLE CORE DATA, MUTABLE METADATA**

**Rationale:**

- `conversation_events` is already immutable (triggers prevent updates/deletes)
- Claims derive from conversation_events, so core claim data should be immutable
- Metadata (confidence scores, status) can evolve as new information arrives

**Immutable fields (never change after creation):**

- `claim_type`, `subject`, `claim_value` - The actual claim content
- `source_event_id` - Provenance
- `claimed_by`, `claimed_by_source`, `claimed_at` - Attribution
- `certainty_language`, `context_original`, `language_original` - Original context
- `inference_method` - Whether claim is direct/inferred (derivations via claim_relationships are immutable edges)

**Note**: `entity_id` and `entity_type` are nullable legacy fields. Use `claim_entities` join table for all entity associations.

**Mutable fields (can be updated):**

- `status` - 'active' → 'superseded' → 'disputed' (state machine)
- `confidence` - Recalculated as supporting/contradicting evidence emerges
- `claim_strength`, `strength_factors` - Updated after LLM evaluation
- `needs_llm_evaluation`, `llm_evaluated_at` - Processing flags
- `redacted`, `redacted_at`, `redacted_by`, `redaction_reason` - Privacy/moderation
- `updated_at` - Timestamp of last metadata change

**Implementation:**

```sql
-- Migration: 20260121008_make_claims_immutable.sql

-- Note: IS DISTINCT FROM handles both NULL comparisons and no-op updates correctly:
-- - NULL IS DISTINCT FROM NULL → FALSE (allows updates when both are NULL)
-- - 'value' IS DISTINCT FROM 'value' → FALSE (allows no-op updates)
-- - Only raises exception if an immutable field actually changes
CREATE OR REPLACE FUNCTION enforce_claims_immutability()
RETURNS TRIGGER AS $$
BEGIN
  -- IS DISTINCT FROM returns FALSE when values are equal (including NULL = NULL)
  -- This allows no-op updates that don't actually change immutable fields
  IF OLD.claim_type IS DISTINCT FROM NEW.claim_type OR
     OLD.subject IS DISTINCT FROM NEW.subject OR
     OLD.claim_value IS DISTINCT FROM NEW.claim_value OR
     OLD.source_event_id IS DISTINCT FROM NEW.source_event_id OR
     OLD.claimed_by IS DISTINCT FROM NEW.claimed_by OR
     OLD.claimed_by_source IS DISTINCT FROM NEW.claimed_by_source OR
     OLD.claimed_at IS DISTINCT FROM NEW.claimed_at OR
     OLD.certainty_language IS DISTINCT FROM NEW.certainty_language OR
     OLD.context_original IS DISTINCT FROM NEW.context_original OR
     OLD.language_original IS DISTINCT FROM NEW.language_original OR
     OLD.inference_method IS DISTINCT FROM NEW.inference_method THEN
     -- Note: derivations are modeled via claim_relationships, which are immutable edges
    RAISE EXCEPTION 'Cannot modify immutable claim fields. Create a new claim instead.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_claims_immutable
  BEFORE UPDATE ON claims
  FOR EACH ROW EXECUTE FUNCTION enforce_claims_immutability();

-- Prevent deletes
CREATE OR REPLACE FUNCTION prevent_claim_deletes()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Cannot delete claims. Use status=redacted instead.';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_claims_no_delete
  BEFORE DELETE ON claims
  FOR EACH ROW EXECUTE FUNCTION prevent_claim_deletes();
```

**Benefits:**

- Complete audit trail - original claims never lost
- Superseded claims remain queryable for historical analysis
- Supports temporal queries: "what did we know on 2025-06-01?"
- LLM evaluation updates don't destroy original algorithmic scores

**Superseding claims workflow:**

```sql
-- Instead of updating, create new claim and link
INSERT INTO claims (...) VALUES (...);  -- id = claim_2 (refined version)
INSERT INTO claim_relationships (family_id, claim_id, related_claim_id, relationship_type)
VALUES (family_uuid, claim_2, claim_1, 'refines');
UPDATE claims SET status = 'superseded' WHERE id = claim_1;
```

---

## Design Decisions

### ✅ Decided

1. **Merge workflow**: **Confidence-based threshold**
   - High confidence (>0.9): Create merge immediately
   - Medium confidence (0.7-0.9): Do not merge, log for manual review
   - Low confidence (<0.7): Create as separate entity, no merge
   - **Rationale**: Merges only exist for confirmed matches. No "proposed" status - keeps `entity_merges` simple and deletable.

2. **Neo4j timeline**: **Not now (prepare schema only)**
   - Add graph metadata columns (graph_labels, temporal bounds)
   - Add neo4j_synced_at for future sync
   - Defer actual Neo4j integration until relationship queries become bottleneck
   - **Rationale**: Lower upfront complexity, can add when needed

3. **Claim strength calculation**: **Hybrid automatic + selective LLM**
   - Algorithmic scoring for all claims (90-95%, $0 cost)
   - LLM evaluation for complex/conflicting claims (5-10%)
   - Store complete breakdown in strength_factors JSONB
   - **Rationale**: Cost-optimized while maintaining context-aware intelligence

4. **Entity versioning approach**: **Self-referential (superseded_by column)**
   - Track merges via `superseded_by`, `superseded_at` columns (merge_reason lives on entity_merges only)
   - Query current entities: `WHERE superseded_by IS NULL`
   - **Active merges**: `entity_merges` table (mutable, deletable); `superseded_by` columns are derived cache
   - **No separate version tables needed** - claims already provide complete temporal provenance
   - **Rationale**: Entity tables are derived summaries maintained for fast reads; the canonical truth is claims (facts + provenance), rooted in the immutable conversation_events ledger. `entity_merges` tracks active merge decisions and can be deleted to undo merges.
   - For "what we knew about Maria on 2025-06-01": query claims WHERE entity_id = maria AND created_at <= date
