# ADR-025: Claims-Based Data Architecture

## Status

Accepted

## Date

2026-01-21

## Context

The system needed a robust approach to entity resolution, data provenance, and conflict management that could:

- Track entity merges with full auditability and reversibility
- Support multi-entity claims (claims involving multiple people, places, events)
- Handle identity resolution explicitly (descriptive names → real names)
- Query claims across merged entities efficiently
- Preserve complete provenance even after entities are merged

Initial approaches using direct entity tables with simple deduplication couldn't handle:

- Merge reversibility (once entities merged, no way to undo)
- Complex claims involving multiple entities
- Clear audit trail of merge decisions
- Temporal queries ("what did we know about Maria on June 1, 2025?")

## Decision

Implement a claims-as-canonical-truth architecture with four key components:

### 1. Claims as Source of Truth

**Claims table provides immutable provenance:**

- Every fact is a claim with `source_event_id`, `created_at`, `claimed_by`
- Claims are immutable once created (core fields cannot be updated)
- Entity tables (`people`, `places`, etc.) are materialized views for query performance
- Temporal history is queryable via claims: "what we knew at time T" = query claims WHERE created_at <= T

### 2. Entity Merge Tracking

**`entity_merges` table tracks active merges:**

- Records source entity → target entity with confidence and reason
- Merge strategies: `fuzzy_match`, `identity_claim`, `manual`, `llm_resolved`
- Deletable to undo merges (provenance preserved in claims)
- Circular merge prevention via database trigger
- Denormalized `superseded_by` columns on entity tables for query performance

**Sync contract:**

- Registrar writes to `entity_merges` AND updates `superseded_by` in same transaction
- If they diverge, `entity_merges` wins (rebuild cache from it)
- No other component may write to `superseded_by` directly

### 3. Claim-Entity Join Table

**`claim_entities` table enables many-to-many relationships:**

- Allows claims to reference multiple entities
- Includes role (`subject`, `related`, `location`) and significance metadata
- Supports identity resolution with `resolved`, `entity_merge_id` fields
- Efficient bidirectional lookup (claim → entities, entity → claims)
- Composite foreign keys enforce tenant integrity at database level

**Query helper `get_entity_merge_chain()`:**

- Traverses `entity_merges` to find all predecessors of an entity
- Used to query "all claims about entity B including claims originally about merged entity A"
- Ensures consistency even if denormalized columns temporarily out of sync

### 4. Service Extraction Pattern

**Business logic extracted to services:**

- `EntityMatcherService` - Entity deduplication with fuzzy matching
- `ConflictDetectorService` - Detects contradicting claims
- `StrengthCalculatorService` - Hybrid scoring (algorithmic + LLM)
- `MergeHandlerService` - Entity merge operations
- `DataRetrieverService` - Shared data retrieval patterns

Registrar becomes orchestrator, services are testable and reusable.

## Consequences

### Positive

- **Complete provenance:** Every fact traces to source conversation event
- **Reversible merges:** Delete `entity_merges` record to undo, claims remain intact
- **Temporal queries:** Can reconstruct "what we knew at any point in time"
- **Multi-entity claims:** Natural support for "Maria married José in 1920" (2 people + relationship)
- **Explicit identity resolution:** Tracks descriptive → real name resolutions
- **Efficient queries:** Denormalized `superseded_by` for performance, authoritative `entity_merges` for integrity
- **Testable services:** Business logic separated from orchestration
- **Shared retrieval:** `DataRetrieverService` used by both Registrar and Historian

### Negative

- **More joins:** Queries need to join through `claim_entities` and `entity_merges`
- **Sync complexity:** Must keep `entity_merges` and `superseded_by` in sync
- **More tables:** Added `entity_merges`, `claim_entities`, `claim_relationships`
- **Migration effort:** Requires migrating from direct entity references to join table

### Trade-off

**Data integrity and auditability worth the complexity.**

The system prioritizes correctness over simplicity. For a family memory platform where trust and accuracy are paramount, the ability to:

- Show complete provenance for every fact
- Undo incorrect merges without data loss
- Query historical state at any point in time
- Track confidence and resolve conflicts

...is more valuable than having a simpler schema with fewer joins.

Performance impact is mitigated through strategic indexes on join tables and denormalized columns for common queries.
