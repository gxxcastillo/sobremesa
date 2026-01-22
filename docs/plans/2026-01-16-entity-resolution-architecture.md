# Research Notes: Entity Resolution & Knowledge Graph Architecture

> **Part of**: [Data Architecture Overview](./2026-01-21-data-architecture-overview.md) - Start here for the big picture

**Status:** Research complete — See [Data Architecture Redesign](./2026-01-21-data-architecture-redesign.md) for implementation decisions
**Date:** 2026-01-16
**Superseded by:** `2026-01-21-data-architecture-redesign.md` (for implementation details)

> **Note**: This document contains background research and exploration. The actual implementation decisions are captured in the Data Architecture Redesign plan. Key decisions made:
>
> - **Option 2 selected** (Keep Supabase, add LLM-based entity resolution)
> - **Neo4j deferred** (schema prepared but integration not implemented)
> - **entity_merges table** (not claim_type='entity_merge') as source of truth for merges
> - **identity_claims table** as first-class entity for identity resolution

---

# Summary

We identified overlap between the `claims` and `people` tables. Research led to exploring existing entity resolution tools and knowledge graph approaches. The **Neo4j hybrid approach** emerged as the best fit for Sobremesa.

---

# Plan: Claims vs People Table Architecture

## Current State

The schema comments explicitly state that **claims should be the canonical source of truth**:

- `claims` table comment: "Canonical truth layer"
- `people` table comment: "Derived summary; canonical provenance lives in claims"

But the implementation treats them as **co-authoritative**:

- Registrar writes to BOTH claims AND people directly
- The `updateName` function I added continues this pattern
- Aliases in `people.aliases` duplicate `claim_value.real_name` in claims

## The Problem

When we process "Dexter's ex-wife was Judy Dor":

| Location             | What's stored             |
| -------------------- | ------------------------- |
| `claims.claim_value` | `{real_name: "Judy Dor"}` |
| `claims.subject`     | `"Dexter's ex-wife"`      |
| `people.name`        | `"Judy Dor"`              |
| `people.aliases`     | `["Dexter's ex-wife"]`    |

Same information stored twice, with complex merge logic to keep them in sync.

---

## Existing Tools & Services

### Entity Resolution Services

1. **[Senzing](https://senzing.com/)** - Enterprise entity resolution API
   - Handles billions of records, real-time resolution
   - AWS Marketplace available, custom pricing based on record count
   - SDK for Python, Java, Go, .NET
   - Overkill for family history use case?

2. **[Splink](https://moj-analytical-services.github.io/splink/)** - Open source (Python)
   - Probabilistic record linkage, no training data needed
   - Won OpenUK Awards 2025
   - Used by Australian Bureau of Statistics for national linkage
   - Can run locally on laptop for ~1M records/minute
   - **Good fit**: Could use for batch deduplication/merging

3. **[Zingg](https://www.zingg.ai/)** - Open source ML-based
   - Connects to various data sources
   - More enterprise-focused

### Graph Databases (Genealogy-Native)

4. **[Neo4j](https://neo4j.com/blog/developer/discover-auradb-free-importing-gedcom-files-and-exploring-genealogy-ancestry-data-as-a-graph/)** - Graph database
   - Natural fit for family trees (nodes = people, edges = relationships)
   - GEDCOM import support exists
   - Entity resolution via graph algorithms
   - **Interesting**: Could replace both `people` and `relationships` tables with a graph

### Genealogy-Specific Approaches

- [Othram](https://othram.com/research/) converts GEDCOM to graphs for forensic genealogy
- FamilySearch uses knowledge graphs internally
- Most genealogy software speaks GEDCOM for data exchange

---

## LLM-Powered Approaches (Most Relevant for Your Use Case)

### Neo4j LLM Knowledge Graph Builder

[Source](https://neo4j.com/labs/genai-ecosystem/llm-graph-builder/)

**How it works:**

1. LLM extracts entities + relationships from unstructured text
2. KG Writer creates nodes (no assumptions about similarity)
3. **Entity Resolver** merges similar entities using:
   - Simple: Same label + identical name
   - Semantic: spaCy embeddings + cosine similarity
   - Fuzzy: RapidFuzz (Levenshtein distance)
4. Optional: Microsoft GraphRAG's Leiden clustering for community summaries

**Fit for Sobremesa:** Very good - handles conversational text, has provenance tracking, built-in entity resolution.

### KGGen (arxiv.org/html/2502.09956v1)

**Architecture:**

1. **Generate**: Extract entities + triples from text (GPT-4o)
2. **Aggregate**: Combine graphs across messages
3. **Cluster**: Iterative LLM-based entity merging
   - LLM proposes a cluster ("Judy Dor" = "Dexter's ex-wife")
   - LLM-as-Judge validates
   - Assign representative label
   - Repeat until stable

**Fit for Sobremesa:** The clustering approach is elegant - LLM decides what merges, not just fuzzy string matching.

> **Implementation note**: The data architecture plan supports this pattern via:
>
> - `entity_merges` table with `merge_strategy = 'llm_resolved'`
> - `identity_claims` table for descriptive→canonical resolution
> - `needs_llm_evaluation` flag on claims for selective LLM enhancement

---

## Concrete Options

### Option 1: Adopt Neo4j + LLM Graph Builder

- Replace Supabase tables with Neo4j graph
- Use their extraction pipeline instead of Scribe
- Built-in entity resolution
- **Effort**: High (migration)
- **Benefit**: Battle-tested, graph-native queries, RAG-ready

### Option 2: Keep Supabase, Add LLM-Based Entity Resolution

- Keep current architecture
- Add a post-processing step using LLM to detect merges
- Similar to KGGen's cluster stage
- Store merge decisions in claims table
- **Effort**: Medium
- **Benefit**: Single source of truth, minimal migration

### Option 3: Keep Supabase, Use Splink for Batch Dedup

- Run Splink periodically on people table
- Surface potential duplicates for review
- **Effort**: Low
- **Benefit**: Quick win, proven algorithm
- **Downside**: Doesn't understand "Dexter's ex-wife = Judy Dor" semantically

### Option 4: Hybrid - Claims + LLM Resolver

- Scribe extracts to claims only (stop writing to people)
- New "Resolver" agent uses LLM to propose entity clusters
- Materialized people table from resolved claims
- **Effort**: Medium-High
- **Benefit**: Clean architecture, LLM-powered resolution

---

## Recommendation for Medium Scale (100-1000 people)

**Option 2** was selected as the approach:

- Don't migrate to Neo4j yet (can do later if needed)
- ~~Add an LLM-based entity resolution step after Registrar~~ → **Updated**: Entity resolution happens **within Registrar** via `EntityMatcherService` (see [Chatbots App Changes](./2026-01-21-chatbots-app-data-architecture-changes.md))
- ~~Store merge decisions as claims (`claim_type: "entity_merge"`)~~ → **Updated**: Use dedicated `entity_merges` table as source of truth (see data architecture plan)
- Revert the `updateName` function - let the resolver handle it
- People table becomes "current best understanding"

This gives you:

- Claims as source of truth for **facts** (audit trail)
- `entity_merges` table as source of truth for **merge decisions**
- LLM-powered semantic entity resolution (within Registrar's EntityMatcherService)
- Minimal architectural change
- Path to Neo4j later if needed

> **Implementation**: See [Data Architecture Redesign](./2026-01-21-data-architecture-redesign.md) for the full schema including:
>
> - `entity_merges` table (mutable, deletable - no status workflow)
> - `identity_claims` table for descriptive→canonical name resolution
> - Circular merge prevention via database trigger
> - Composite foreign keys for tenant integrity

---

## Detailed Plan: Neo4j Hybrid Integration (DEFERRED)

> **Status**: Deferred. Schema preparation is included in the data architecture plan (graph_labels, temporal bounds, neo4j_synced_at columns), but actual Neo4j integration is deferred until relationship queries become a bottleneck.

**Architecture: Neo4j for people/relationships, Supabase for claims/stories**

### Why Hybrid?

- Neo4j excels at relationship traversal (family trees, paths)
- Claims work better in JSONB PostgreSQL (rich structure, FTS, audit trail)
- Minimal changes to Scribe - it continues as-is
- Registrar just adds sync writes to Neo4j

### Data Flow (After Integration)

```
Telegram → Scribe → Registrar → Supabase + Neo4j (sync)
                         ↓
          Historian queries:
            - Relationship/family_tree → Neo4j
            - Other questions → Supabase
```

### Files to Create/Modify

| File                                                                        | Type   | Description                    |
| --------------------------------------------------------------------------- | ------ | ------------------------------ |
| `libs/database/src/lib/neo4j-client.ts`                                     | NEW    | Neo4j connection factory       |
| `libs/database/src/lib/repositories/neo4j/person-graph-repository.ts`       | NEW    | Graph queries for people       |
| `libs/database/src/lib/repositories/neo4j/relationship-graph-repository.ts` | NEW    | Relationships in graph         |
| `libs/database/src/lib/repositories/neo4j/graph-traversal-repository.ts`    | NEW    | Family tree / shortest path    |
| `libs/agents/registrar/src/lib/registrar.ts`                                | MODIFY | Sync writes to Neo4j           |
| `libs/agents/historian/src/lib/graph-retriever.ts`                          | NEW    | Neo4j-backed retrieval         |
| `libs/agents/historian/src/lib/historian.ts`                                | MODIFY | Route graph questions to Neo4j |

### Phase 1: Foundation

1. Add `neo4j-driver` package
2. Create Neo4j client + connection config
3. Create Neo4j schema (constraints, indexes)
4. Create `PersonGraphRepository`, `RelationshipGraphRepository`

### Phase 2: Registrar Sync

1. Modify Registrar to sync writes to Neo4j
2. Add feature flag `SYNC_NEO4J=true`
3. Handle errors gracefully (log + continue)

### Phase 3: Historian Enhancement

1. Create `GraphDataRetriever` with Cypher queries
2. Route relationship/family_tree questions to Neo4j
3. Fallback to SQL for other question types

### Phase 4: Testing + Optimization

1. Integration tests for Neo4j
2. Performance benchmarking (compare SQL vs Cypher)
3. Monitor consistency between DBs

### What This Would Solve (when implemented)

- **Entity resolution**: ~~Neo4j's built-in algorithms + LLM Graph Builder option~~ → **Current approach**: `entity_merges` table + LLM-based resolution in Registrar (see data architecture plan)
- **Relationship queries**: 1 Cypher query vs 5+ SQL queries
- **Family tree visualization**: Native graph representation
- **Claims provenance**: Still in Supabase with full audit trail

### What to Revert (if adopting Neo4j)

- Remove the `updateName` function added earlier
- ~~Remove identity claim handling in Registrar (let Neo4j handle merging)~~ → **Retained**: Registrar handles identity claims via `identity_claims` table
- Let Scribe/Registrar write entities, ~~Neo4j~~ `entity_merges` table handles resolution

---

## Current Code Changes (Already Applied)

These changes were made during this session:

1. **`libs/prompts/src/agents/facilitator.txt`** - Made Permission component optional (KEEP)
2. **`libs/prompts/src/agents/scribe.txt`** - Added pronoun rules, reference resolution, identity claims (KEEP)
3. **`libs/database/src/lib/repositories/person-repository.ts`** - Added `updateName()` method (REVERT if using Neo4j; otherwise retained for manual corrections)
4. **`libs/agents/registrar/src/lib/registrar.ts`** - Added identity claim handling → **Enhanced**: Will use `identity_claims` table per data architecture plan

---

## Next Steps When Resuming

> **Decision made**: Option 2 (Keep Supabase + LLM-based entity resolution). See [Data Architecture Redesign](./2026-01-21-data-architecture-redesign.md) for implementation.

1. ~~**Decide on approach**: Neo4j hybrid vs LLM-only entity resolution~~ → **Done**: Option 2 selected
2. ~~**If Neo4j**: Start with Phase 1 (foundation)~~ → **Deferred**: Schema prepared, integration later
3. ~~**If LLM-only**: Create a new "Resolver" agent~~ → **Evolved**: Registrar handles resolution with `entity_merges` table + future LLM enhancement
4. **Implement data architecture plan**: Create migrations for entity_merges, identity_claims, claim_entities tables

---

## Key Resources

- [Neo4j LLM Graph Builder](https://neo4j.com/labs/genai-ecosystem/llm-graph-builder/)
- [KGGen Paper](https://arxiv.org/html/2502.09956v1) - LLM-based entity clustering
- [Splink](https://moj-analytical-services.github.io/splink/) - Open source record linkage
- [Senzing](https://senzing.com/) - Enterprise entity resolution (if you need to scale)

---

## Original Issues (From This Session)

1. ✅ Carmencita too apologetic - Fixed in facilitator prompt
2. ✅ "her niece" becoming 2 people - Fixed in scribe prompt
3. ⏸️ "Judy Dor" vs "Dexter's ex-wife" → **Addressed**: `identity_claims` table + `entity_merges` table handle this (see data architecture plan)
4. ⏸️ Relationships table empty - Deferred to Neo4j (schema prepared, integration deferred)
5. ⏸️ Stories table empty - Schema was correct, may need more conversation data
6. ✅ "He" as alias - Fixed in scribe prompt
