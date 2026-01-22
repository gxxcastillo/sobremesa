# Data Architecture Redesign: Overview

**Status:** Planning complete, ready for implementation
**Date:** 2026-01-21

---

## Executive Summary

### The Problem

Sobremesa extracts family history from conversations, but the current architecture has limitations:

1. **Entity duplication** - "Dexter's ex-wife" and "Judy Dor" become separate people with no way to merge them
2. **No conflict handling** - Contradictory claims (e.g., two different birth years) aren't detected or tracked
3. **Weak provenance** - Hard to answer "why do we believe this?" or trace claims back to sources
4. **Tight coupling** - Entity matching, conflict detection, and persistence are intertwined in Registrar
5. **Limited testability** - Business logic embedded in agents makes unit testing difficult

### The Solution

A comprehensive redesign that:

1. **Adds entity merge tracking** - Explicit `entity_merges` table for active merges (deletable to undo)
2. **Introduces claim relationships** - Track when claims support, contradict, or refine each other
3. **Calculates claim strength** - Score claims based on source type, certainty language, and conflicts
4. **Extracts services from Registrar** - Testable services for matching, conflicts, strength, and merges
5. **Creates shared data retrieval** - `DataRetrieverService` used by both Registrar and Historian
6. **Enables data integrity validation** - Tooling to verify referential integrity and replay processing

---

## Architecture Overview

### Current Flow

```
Telegram → Ingester → ConversationEvent → Intern (routing)
                                              ↓
                         ┌────────────────────┼────────────────────┐
                         ↓                    ↓                    ↓
                      [Admin]             [Scribe]            [Historian]
                                              ↓
                                        DomainModel
                                              ↓
                                        [Registrar]
                                              ↓
                                     people/claims/etc.
```

### New Flow

```
Telegram → Ingester → ConversationEvent (+ sequence_number)
                          ↓
                        Intern (routing)
                          ↓
     ┌────────────────────┼────────────────────┐
     ↓                    ↓                    ↓
  [Admin]             [Scribe]            [Historian]
                          ↓
                      DomainModel (+ inference signals)
                          ↓
                     [Registrar] ─── orchestrator ──────────────────┐
                          │                                         │
            ┌─────────────┼─────────────┐                           │
            ↓             ↓             ↓                           ↓
    EntityMatcher  ConflictDetector  StrengthCalc              MergeHandler
            │             │             │                           │
            └─────────────┼─────────────┘                           │
                          ↓                                         │
                 DataRetrieverService  ←────────────────────────────┘
                          ↓                                         ↑
                     Repositories                                   │
                          ↓                                         │
                       Database                                     │
                          ↓                                         │
                     [Historian]  ──────────────────────────────────┘
```

### Key Architectural Decisions

| Decision                       | Choice                                            | Rationale                                 |
| ------------------------------ | ------------------------------------------------- | ----------------------------------------- |
| Entity resolution approach     | Keep Supabase + LLM-based resolution in Registrar | Minimal migration, Option 2 from research |
| Merge tracking                 | Dedicated `entity_merges` table                   | Explicit, deletable to undo               |
| Where entity matching lives    | `EntityMatcherService` in Registrar               | Transactional, testable                   |
| Where conflict detection lives | `ConflictDetectorService` in Registrar            | Access to context, testable               |
| Shared retrieval               | `DataRetrieverService` in libs/database           | Avoids Registrar↔Historian coupling      |
| Neo4j integration              | Deferred (schema prepared)                        | Not needed yet, can add later             |

---

## Document Map

### Reading Order

```
1. [Overview] ← You are here
       ↓
2. [Entity Resolution] ← Background research (optional, superseded)
       ↓
3. [Data Architecture] ← Database schema changes
       ↓
4. [Chatbots App Changes] ← Application code changes
       ↓
5. [Data Integrity Testing] ← Validation and testing tooling
```

### Document Details

| Document                                                                             | What It Covers                                                                            | Key Sections                                                        |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **[Entity Resolution Architecture](./2026-01-16-entity-resolution-architecture.md)** | Background research on entity resolution approaches, Neo4j evaluation, decision rationale | Options explored, recommendation, deferred Neo4j plan               |
| **[Data Architecture Redesign](./2026-01-21-data-architecture-redesign.md)**         | Database schema changes, SQL migrations, triggers, functions                              | Phase 1-5 migrations, entity_merges, claim_entities, claim strength |
| **[Chatbots App Changes](./2026-01-21-chatbots-app-data-architecture-changes.md)**   | Application code changes to agents and services                                           | Registrar services, DataRetrieverService, Scribe/Historian updates  |
| **[Data Integrity Testing](./2026-01-21-data-integrity-testing.md)**                 | Validation queries, replay tooling, testing infrastructure                                | Polymorphic validation, Registrar replay, golden fixtures           |

---

## Key Concepts

### Entity Merges

When we determine that two entities are the same (e.g., "Dexter's ex-wife" = "Judy Dor"):

1. Create `entity_merges` record (tracks active merge, deletable to undo)
2. Set `superseded_by` on source entity (denormalized for query performance)
3. Target entity gains source's name as alias
4. Claims retain original entity references (preserves provenance)
5. Queries use merge chain to find all related claims

### Claim Strength

Each claim gets a strength score (0.0-1.0) based on:

- **Source type**: direct (1.0) > attributed (0.8) > hearsay (0.5)
- **Certainty language**: "definitely" (1.0) > "probably" (0.9) > "maybe" (0.5)
- **Conflicts**: Each conflict applies 0.8 multiplier
- **Inference method**: direct (1.0) > logical (0.9) > LLM (0.8)

Claims with conflicts, hearsay sources, or low scores are flagged for optional LLM evaluation.

### Join Tables

Arrays are replaced with join tables for better querying and metadata:

| Old (Array)                 | New (Join Table)     | Benefits                      |
| --------------------------- | -------------------- | ----------------------------- |
| `stories.people[]`          | `story_entities`     | Role, significance per entity |
| `events.people_involved[]`  | `event_participants` | Role per participant          |
| `claims.entity_id` (single) | `claim_entities`     | Multiple entities per claim   |

### Migrations

We're still in the development phase of the app, so database migrations should all be added to
the xxx_init_schema.sql instead of creating separate migration files and the db should be reset.

---

## Implementation Phases

### Phase 1: Database Foundation (Week 1)

**Goal**: Schema changes with no application code changes yet

| Task                                        | Document          | Migrations |
| ------------------------------------------- | ----------------- | ---------- |
| Add sequence numbers to conversation_events | Data Architecture | 001        |
| Add ingestion_batches table                 | Data Architecture | 001        |
| Add entity merge tracking columns           | Data Architecture | 002        |
| Create entity_merges table                  | Data Architecture | 002        |
| Create identity_claims table                | Data Architecture | 003        |
| Create claim_entities table                 | Data Architecture | 004        |
| Enhance claims table (strength fields)      | Data Architecture | 005        |
| Create claim_relationships table            | Data Architecture | 006        |

**Note**: `ingestion_batch_id` on conversation_events is **nullable**. It is only populated for batch operations (cron jobs, manual imports). Real-time Telegram messages have `NULL` ingestion_batch_id since they are processed individually.

**Verification**: All migrations run successfully, existing data intact

### Phase 2: Types and Repositories (Week 1-2)

**Goal**: TypeScript types and repository CRUD operations

| Task                                     | Document          | Files                         |
| ---------------------------------------- | ----------------- | ----------------------------- |
| Update entity types (supersededBy, etc.) | Chatbots App      | libs/shared/types/entities.ts |
| Update claim types (strength, etc.)      | Chatbots App      | libs/shared/types/claims.ts   |
| Create EntityMergeRepository             | Data Architecture | libs/database/repositories/   |
| Create IdentityClaimRepository           | Data Architecture | libs/database/repositories/   |
| Create ClaimEntityRepository             | Data Architecture | libs/database/repositories/   |
| Create ClaimRelationshipRepository       | Data Architecture | libs/database/repositories/   |
| Create StoryEntityRepository             | Data Architecture | libs/database/repositories/   |
| Create EventParticipantRepository        | Data Architecture | libs/database/repositories/   |
| Create DataRetrieverService              | Chatbots App      | libs/database/services/       |

**Verification**: Repository unit tests pass

### Phase 3: Registrar Services (Week 2-3)

**Goal**: Extract business logic into testable services

| Task                               | Document     | Files                           |
| ---------------------------------- | ------------ | ------------------------------- |
| Create StrengthCalculatorService   | Chatbots App | libs/agents/registrar/services/ |
| Create EntityMatcherService        | Chatbots App | libs/agents/registrar/services/ |
| Create ConflictDetectorService     | Chatbots App | libs/agents/registrar/services/ |
| Create MergeHandlerService         | Chatbots App | libs/agents/registrar/services/ |
| Refactor Registrar to use services | Chatbots App | libs/agents/registrar/          |

**Verification**: Service unit tests pass, Registrar integration tests pass

### Phase 4: Data Migration (Week 3)

**Goal**: Migrate existing data to new schema

| Task                                                 | Document          | Script           |
| ---------------------------------------------------- | ----------------- | ---------------- |
| Migrate stories arrays to story_entities             | Data Architecture | Migration script |
| Migrate events arrays to event_participants          | Data Architecture | Migration script |
| Migrate claims.entity_id to claim_entities           | Data Architecture | Migration script |
| Calculate initial claim_strength for existing claims | Data Architecture | Migration script |

**Verification**: Validation queries show 100% migration, no orphans

### Phase 5: Integration and Testing (Week 4)

**Goal**: End-to-end verification and tooling

| Task                                         | Document       | Files                  |
| -------------------------------------------- | -------------- | ---------------------- |
| Update Historian to use DataRetrieverService | Chatbots App   | libs/agents/historian/ |
| Minor Scribe output updates                  | Chatbots App   | libs/agents/scribe/    |
| Create data integrity validation CLI         | Data Integrity | apps/db/scripts/       |
| Create Registrar replay tool                 | Data Integrity | apps/db/scripts/       |
| End-to-end testing                           | All            | tests/                 |

**Verification**: Full pipeline works, validation passes, replay matches

---

## Dependencies

```
                    ┌─────────────────────────────┐
                    │   Phase 1: Migrations       │
                    │   (no code dependencies)    │
                    └─────────────┬───────────────┘
                                  │
                    ┌─────────────▼───────────────┐
                    │   Phase 2: Types + Repos    │
                    │   (depends on schema)       │
                    └─────────────┬───────────────┘
                                  │
          ┌───────────────────────┼───────────────────────┐
          │                       │                       │
┌─────────▼─────────┐   ┌────────▼────────┐   ┌─────────▼─────────┐
│ Phase 3: Services │   │ Phase 4: Data   │   │ DataRetriever     │
│ (depends on repos)│   │ Migration       │   │ (depends on repos)│
└─────────┬─────────┘   └────────┬────────┘   └─────────┬─────────┘
          │                       │                       │
          └───────────────────────┼───────────────────────┘
                                  │
                    ┌─────────────▼───────────────┐
                    │   Phase 5: Integration      │
                    │   (depends on all above)    │
                    └─────────────────────────────┘
```

---

## Success Criteria

### Functional

- [ ] Entity merges tracked in `entity_merges` table with reason and confidence
- [ ] Merged entities have `superseded_by` set correctly
- [ ] Claims linked to multiple entities via `claim_entities`
- [ ] Claim strength calculated for all new claims
- [ ] Conflicts detected and recorded in `claim_relationships`
- [ ] Identity claims create merge records when resolved
- [ ] Historian queries return claims from merged entities

### Data Integrity

- [ ] All polymorphic references point to existing entities
- [ ] All `superseded_by` entities have corresponding `entity_merges` record
- [ ] No circular merge chains
- [ ] All claims have at least one `claim_entities` link

### Performance

- [ ] Entity matching < 100ms for families with < 1000 people
- [ ] Claim strength calculation < 10ms per claim
- [ ] Conflict detection < 50ms per claim

### Testing

- [ ] Service unit test coverage > 80%
- [ ] Registrar replay matches production for existing data
- [ ] Data integrity validation passes on production

---

## Risks and Mitigations

| Risk                               | Likelihood | Impact | Mitigation                                 |
| ---------------------------------- | ---------- | ------ | ------------------------------------------ |
| Migration breaks existing data     | Low        | High   | All changes additive; run in staging first |
| Performance degradation from joins | Medium     | Medium | Strategic indexes; monitor query plans     |
| Service extraction introduces bugs | Medium     | Medium | Comprehensive tests before refactoring     |
| LLM costs from entity matching     | Low        | Low    | LLM optional; only for uncertain matches   |

---

## Open Questions

1. **Scribe output storage**: Should we store Scribe's domain model output for replay testing? (See Data Integrity plan)
2. **Merge review UI**: How will users review potential matches (medium-confidence) and trigger/undo merges? (Deferred to future work)
3. **Bulk retroactive strength calculation**: Should we recalculate strength for all historical claims? (Recommended for Phase 4)

---

## Glossary

| Term               | Definition                                                                 |
| ------------------ | -------------------------------------------------------------------------- |
| **Entity**         | A person, place, event, or story in the family history                     |
| **Claim**          | A single fact extracted from conversation (e.g., "Maria was born in 1920") |
| **Entity merge**   | Combining two entities that represent the same real-world thing            |
| **Superseded**     | An entity that has been merged into another (no longer current)            |
| **Claim strength** | Confidence score (0.0-1.0) based on source, certainty, and conflicts       |
| **Merge chain**    | The sequence of merged entities leading to the current canonical entity    |
| **Identity claim** | A claim that resolves a descriptive name to a canonical name               |

---

## Related Documents

- [Entity Resolution Architecture](./2026-01-16-entity-resolution-architecture.md) - Background research (superseded)
- [Data Architecture Redesign](./2026-01-21-data-architecture-redesign.md) - Database schema
- [Chatbots App Changes](./2026-01-21-chatbots-app-data-architecture-changes.md) - Application code
- [Data Integrity Testing](./2026-01-21-data-integrity-testing.md) - Validation and testing
