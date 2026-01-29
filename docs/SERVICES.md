# Service Layer

**Business logic extraction for testable, reusable components.**

---

## Architecture

```
Agent (Orchestrator)
    │
    ├── Service 1 (Business Logic)
    ├── Service 2 (Business Logic)
    └── Service 3 (Business Logic)
          │
          ▼
    Repositories (Data Access)
```

**Pattern:** Agents orchestrate, services implement business rules, repositories handle data.

---

## Core Services

### EntityMatcherService

**Purpose:** Find duplicate entities using fuzzy matching

**Strategy:**

1. Exact name match
2. Alias match
3. Fuzzy match (Levenshtein distance)
4. Optional LLM verification (future)

**Confidence thresholds:**

- `> 0.9` → Auto-merge
- `0.7-0.9` → Manual review
- `< 0.7` → Separate entity

**Location:** `libs/agents/registrar/src/lib/services/entity-matcher.ts`

---

### ConflictDetectorService

**Purpose:** Detect and resolve conflicting claims

**Conflict types:**

- **Contradicts** - Mutually exclusive (birth year 1920 vs 1922)
- **Refines** - More specific (Nicaragua → Managua, Nicaragua)
- **Supports** - Confirms existing

**Resolution strategy:**

- Compare claim strengths
- Stronger by >0.2 → Supersede weaker
- Similar strength → Mark disputed
- Both preserved for audit trail

**Entity-aware:** Only checks claims for same entity (prevents false conflicts between different people with same name)

**Location:** `libs/agents/registrar/src/lib/services/conflict-detector.ts`

---

### StrengthCalculatorService

**Purpose:** Calculate claim reliability scores

**Two-tier approach:**

**Phase 1 - Algorithmic (all claims):**

- Base score by source: direct (1.0), attributed (0.8), hearsay (0.5)
- Certainty modifier: "definitely" (1.0), "I think" (0.7), "might" (0.6)
- Conflict penalty: 0.8 per contradicting claim
- Final = base × certainty × penalty

**Phase 2 - LLM (5-10% of claims):**

- Triggered by: conflicts, uncertainty, hearsay, high-stakes, low score
- Returns confidence + reasoning
- Blended: (algorithmic × 0.4) + (LLM × 0.6)

**Location:** `libs/agents/registrar/src/lib/services/strength-calculator.ts`

---

### MergeHandlerService

**Purpose:** Merge and unmerge entities

**Merge workflow:**

1. Create `entity_merges` record
2. Update target entity (add source name to aliases)
3. Mark source as superseded
4. Update claim links if identity resolution

**Unmerge workflow:**

1. Delete merge record
2. Clear superseded flag
3. Restore claim links
4. Claims remain intact

**Reversible:** All merges can be undone without data loss

**Location:** `libs/agents/registrar/src/lib/services/merge-handler.ts`

---

### DataRetrieverService

**Purpose:** Shared data access patterns

**Used by:**

- Registrar (entity matching, conflict detection)
- Historian (answering questions)

**Benefits:**

- Single source for common queries
- Consistent patterns
- Easy to optimize (caching, etc.)

**Location:** `libs/database/src/lib/services/data-retriever.ts`

---

## Why Services?

**Before:** Business logic embedded in Registrar (hard to test, hard to reuse)

**After:**

- Registrar orchestrates workflow
- Services implement business rules
- Each service is independently testable
- Services can be shared across agents

**Example:** DataRetrieverService used by both Registrar and Historian

---

## Testing Approach

**Unit tests:** Test service logic in isolation

**Integration tests:** Test service + repository together

**Benefits:**

- Fast tests (no database for unit tests)
- Clear failures (know which service broke)
- Easy mocking (services have clear interfaces)

---

## Future Services

### ClaimAggregatorService

Aggregate claims into entity fields (materialized views for query performance)

### InferenceEngineService

Generate inferred claims from direct claims (logical deduction)

---

## See Also

- [ARCHITECTURE.md](ARCHITECTURE.md) - System architecture
- [ADR-025](adr/025-claims-based-data-architecture.md) - Service extraction decision
- [ADR-027](adr/027-hybrid-claim-strength-scoring.md) - Scoring approach
