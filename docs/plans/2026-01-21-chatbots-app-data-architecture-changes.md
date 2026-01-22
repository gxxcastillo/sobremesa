# Chatbots App Changes for Data Architecture Redesign

> **Part of**: [Data Architecture Overview](./2026-01-21-data-architecture-overview.md) - Start here for the big picture

## Overview

This document assesses the changes required to `apps/chatbots` and its dependent agent libraries (`libs/agents/*`) to support the data architecture redesign outlined in `2026-01-21-data-architecture-redesign.md`.

## Architectural Principles

1. **Scribe** = Language understanding (extracts structured data from text)
2. **Registrar** = Orchestration + business logic (matching, conflicts, strength)
3. **DataRetriever** = Shared retrieval layer (used by Registrar and Historian)
4. **Repositories** = Persistence only (CRUD operations)

This separates:

- **Language understanding** (Scribe - LLM)
- **Data interpretation** (Registrar services - logic + optional LLM)
- **Data retrieval** (DataRetriever - shared queries)
- **Data persistence** (Repositories - writes)

---

## Summary of Changes

| Component                               | Changes                                     | Complexity |
| --------------------------------------- | ------------------------------------------- | ---------- |
| **Scribe**                              | Minor - add strength signals to output      | Low        |
| **Registrar**                           | Major - extract services, use DataRetriever | Medium     |
| **DataRetriever**                       | New shared service (extract from Historian) | Medium     |
| **Historian**                           | Minor - use shared DataRetriever            | Low        |
| **Repositories**                        | New repos for new tables                    | Low        |
| **Ingester**                            | Minor - batch tracking                      | Low        |
| **Intern, Admin, Facilitator, Curator** | None                                        | -          |

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        apps/chatbots                            │
│                                                                 │
│  ┌─────────┐    ┌─────────┐    ┌────────────┐    ┌───────────┐  │
│  │  Intern │    │  Scribe │    │  Historian │    │   Admin   │  │
│  │  Agent  │    │  Agent  │    │   Agent    │    │   Agent   │  │
│  └────┬────┘    └────┬────┘    └─────┬──────┘    └───────────┘  │
│       │              │               │                          │
│       │              ▼               │                          │
│       │     ┌────────────────┐       │                          │
│       │     │   Registrar    │       │                          │
│       │     │     Agent      │       │                          │
│       │     │  ┌──────────┐  │       │                          │
│       │     │  │ Services │  │       │                          │
│       │     │  └────┬─────┘  │       │                          │
│       │     └───────┼────────┘       │                          │
└───────┼─────────────┼────────────────┼──────────────────────────┘
        │             │                │
        │             ▼                ▼
        │     ┌─────────────────────────────┐
        │     │      DataRetriever          │  ← libs/database/services
        │     │    (shared service)         │
        │     └─────────────┬───────────────┘
        │                   │
        │                   ▼
        │     ┌─────────────────────────────┐
        │     │       Repositories          │  ← libs/database/repositories
        │     │   (CRUD, persistence)       │
        │     └─────────────────────────────┘
        │                   │
        └───────────────────┴──────────────────▶ Database
```

---

## 1. Shared DataRetriever Service (NEW)

**Location**: `libs/database/src/lib/services/data-retriever.ts`

### Purpose

Provides higher-level query methods used by both Registrar services and Historian. Single source of truth for "how to query family data."

### Extracted From

Current `libs/agents/historian/src/lib/retriever.ts` - move shared logic here.

### Interface

```typescript
export interface PersonContext {
  id: string;
  name: string;
  aliases: string[];
  birthYear?: number;
  deathYear?: number;
  isPlaceholder?: boolean;
}

export interface PlaceContext {
  id: string;
  name: string;
  type?: string;
  city?: string;
  country?: string;
}

export interface ClaimContext {
  id: string;
  claimType: string;
  subject: string;
  claimValue: Record<string, unknown>;
  claimedBy: string;
  claimedBySource?: ClaimSourceType;
  confidence: Confidence;
  certaintyLanguage?: string;
  status: string;
}

export class DataRetrieverService {
  constructor(
    private personRepo: PersonRepository,
    private placeRepo: PlaceRepository,
    private claimRepo: ClaimRepository,
    private claimEntityRepo: ClaimEntityRepository,
    // ... other repos
  ) {}

  // === Entity Context (for Registrar's EntityMatcher) ===

  async getPeopleContext(familyId: string): Promise<PersonContext[]>;
  async getPlacesContext(familyId: string): Promise<PlaceContext[]>;

  // === Claim Context (for Registrar's ConflictDetector) ===

  async getClaimsForSubject(
    familyId: string,
    subject: string,
  ): Promise<ClaimContext[]>;
  async getActiveClaimsForEntity(
    familyId: string,
    entityId: string,
    entityType: string,
  ): Promise<ClaimContext[]>;

  // === Merge-Aware Queries (for both Registrar and Historian) ===

  async getClaimsForEntityIncludingMerged(
    familyId: string,
    entityId: string,
    entityType: string,
  ): Promise<Claim[]>;

  async getEntityMergeChain(
    familyId: string,
    entityId: string,
    entityType: string,
  ): Promise<string[]>;

  // === Full Context (for Historian) ===

  async getContextForQuestion(
    familyId: string,
    question: string,
  ): Promise<HistorianContext>;

  async getPersonWithRelatedData(
    familyId: string,
    personId: string,
  ): Promise<PersonWithContext>;
}
```

### Files to Create

| File                                               | Purpose       |
| -------------------------------------------------- | ------------- |
| `libs/database/src/lib/services/data-retriever.ts` | Main service  |
| `libs/database/src/lib/services/index.ts`          | Export barrel |

---

## 2. Scribe Agent (`libs/agents/scribe`)

**Status: ⚠️ MINOR CHANGES**

Scribe stays focused on language understanding. Minor additions to output more signals that Registrar services can use.

### Changes to Output

**Current `ExtractedClaim`** - already has most signals:

```typescript
interface ExtractedClaim {
  claimType: string;
  subject: string;
  claimValue: Record<string, unknown>;
  confidence: Confidence;
  certaintyLanguage?: string; // ✓ Already has
  claimedBy?: string; // ✓ Already has
  claimedBySource?: ClaimSourceType; // ✓ Already has
}
```

**Minor additions:**

```typescript
interface ExtractedClaim {
  // ... existing fields ...

  // NEW: Additional signals for strength calculation
  inferenceMethod?: 'direct' | 'logical_inference' | 'llm_inference';

  // NEW: Referenced entities (for claim_entities linking)
  referencedPeople?: string[]; // Names mentioned in claim
  referencedPlaces?: string[]; // Places mentioned in claim
}
```

**ExtractedPerson/ExtractedPlace** - no changes needed. Entity matching happens in Registrar.

### Files to Modify

| File                                            | Changes                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `libs/shared/types/src/lib/domain-model.ts`     | Add `inferenceMethod`, `referencedPeople`, `referencedPlaces` to ExtractedClaim |
| `libs/agents/scribe/src/lib/prompt-builder.ts`  | Minor prompt updates to extract new fields                                      |
| `libs/agents/scribe/src/lib/response-parser.ts` | Parse new fields                                                                |

---

## 3. Registrar Agent (`libs/agents/registrar`)

**Status: ⚠️ MAJOR CHANGES - INTERNAL REFACTOR**

Registrar becomes an orchestrator with extracted services. Business logic moves to testable services.

### New Structure

```
libs/agents/registrar/src/lib/
  ├── registrar.ts              # Orchestrator (simplified)
  ├── services/
  │     ├── entity-matcher.ts   # Entity matching logic
  │     ├── conflict-detector.ts # Claim conflict detection
  │     ├── strength-calculator.ts # Claim strength scoring
  │     └── merge-handler.ts    # Entity merge operations
  └── index.ts
```

### 3.1 EntityMatcherService

**Purpose**: Decide if extracted entity matches existing entity.

```typescript
export interface MatchResult {
  matched: boolean;
  existingEntityId?: string;
  confidence: number; // 0.0-1.0
  matchReason: string; // "exact_name", "alias", "fuzzy", "contextual"
  suggestedAliases?: string[]; // New aliases to add
}

export class EntityMatcherService {
  constructor(
    private dataRetriever: DataRetrieverService,
    private llmClient?: AnthropicClient, // Optional for uncertain matches
  ) {}

  async matchPerson(
    familyId: string,
    extracted: ExtractedPerson,
  ): Promise<MatchResult> {
    const existingPeople = await this.dataRetriever.getPeopleContext(familyId);

    // 1. Exact name match
    const exactMatch = existingPeople.find(
      (p) => p.name.toLowerCase() === extracted.name.toLowerCase(),
    );
    if (exactMatch) {
      return {
        matched: true,
        existingEntityId: exactMatch.id,
        confidence: 1.0,
        matchReason: 'exact_name',
      };
    }

    // 2. Alias match
    const aliasMatch = existingPeople.find((p) =>
      p.aliases.some((a) => a.toLowerCase() === extracted.name.toLowerCase()),
    );
    if (aliasMatch) {
      return {
        matched: true,
        existingEntityId: aliasMatch.id,
        confidence: 1.0,
        matchReason: 'alias',
      };
    }

    // 3. Fuzzy match
    const fuzzyMatch = this.fuzzyMatch(extracted.name, existingPeople);
    if (fuzzyMatch && fuzzyMatch.confidence >= 0.9) {
      return {
        matched: true,
        existingEntityId: fuzzyMatch.id,
        confidence: fuzzyMatch.confidence,
        matchReason: 'fuzzy',
      };
    }

    // 4. Optional: LLM verification for uncertain matches (0.7-0.9)
    if (fuzzyMatch && fuzzyMatch.confidence >= 0.7 && this.llmClient) {
      const llmVerified = await this.verifyMatchWithLlm(extracted, fuzzyMatch);
      if (llmVerified) {
        return {
          matched: true,
          existingEntityId: fuzzyMatch.id,
          confidence: 0.85,
          matchReason: 'contextual',
        };
      }
    }

    // 5. No match - new entity
    return { matched: false, confidence: 0, matchReason: 'no_match' };
  }

  async matchPlace(
    familyId: string,
    extracted: ExtractedPlace,
  ): Promise<MatchResult>;

  private fuzzyMatch(
    name: string,
    existing: PersonContext[],
  ): { id: string; confidence: number } | null;
  private async verifyMatchWithLlm(
    extracted: ExtractedPerson,
    candidate: PersonContext,
  ): Promise<boolean>;
}
```

### 3.2 ConflictDetectorService

**Purpose**: Detect conflicts between new claim and existing claims.

```typescript
export interface ConflictResult {
  hasConflict: boolean;
  conflictingClaimId?: string;
  conflictType?: 'contradicts' | 'refines' | 'supports';
  reasoning?: string;
}

export class ConflictDetectorService {
  constructor(
    private dataRetriever: DataRetrieverService,
    private llmClient?: AnthropicClient, // Optional for semantic conflicts
  ) {}

  async detectConflicts(
    familyId: string,
    newClaim: ExtractedClaim,
  ): Promise<ConflictResult[]> {
    const existingClaims = await this.dataRetriever.getClaimsForSubject(
      familyId,
      newClaim.subject,
    );

    const conflicts: ConflictResult[] = [];

    for (const existing of existingClaims) {
      // 1. Value-based conflict detection (fast, deterministic)
      if (this.valuesConflict(existing.claimValue, newClaim.claimValue)) {
        conflicts.push({
          hasConflict: true,
          conflictingClaimId: existing.id,
          conflictType: 'contradicts',
          reasoning: 'Different values for same fact',
        });
        continue;
      }

      // 2. Optional: LLM for semantic conflict detection
      if (this.llmClient && this.mightBeSemanticConflict(existing, newClaim)) {
        const llmResult = await this.checkSemanticConflict(existing, newClaim);
        if (llmResult.hasConflict) {
          conflicts.push(llmResult);
        }
      }
    }

    return conflicts;
  }

  private valuesConflict(
    existing: Record<string, unknown>,
    newValue: Record<string, unknown>,
  ): boolean;
  private mightBeSemanticConflict(
    existing: ClaimContext,
    newClaim: ExtractedClaim,
  ): boolean;
  private async checkSemanticConflict(
    existing: ClaimContext,
    newClaim: ExtractedClaim,
  ): Promise<ConflictResult>;
}
```

### 3.3 StrengthCalculatorService

**Purpose**: Calculate claim strength from Scribe's signals.

```typescript
export interface StrengthResult {
  score: number; // 0.0-1.0
  factors: StrengthFactors;
  needsLlmEvaluation: boolean; // Flag for complex cases
}

export interface StrengthFactors {
  baseScore: number; // From claimedBySource
  certaintyModifier: number; // From certaintyLanguage
  conflictPenalty: number; // From conflict count
  inferenceDiscount: number; // From inferenceMethod
  final: number;
  reasoning: string;
}

export class StrengthCalculatorService {
  calculate(claim: ExtractedClaim, conflictCount: number): StrengthResult {
    // Base score from source type
    const baseScore = this.getBaseScore(claim.claimedBySource);

    // Certainty modifier from language
    const certaintyModifier = this.getCertaintyModifier(
      claim.certaintyLanguage,
    );

    // Conflict penalty
    const conflictPenalty = Math.pow(0.8, conflictCount);

    // Inference discount
    const inferenceDiscount = this.getInferenceDiscount(claim.inferenceMethod);

    // Final score
    const final =
      baseScore * certaintyModifier * conflictPenalty * inferenceDiscount;

    // Flag for LLM evaluation
    const needsLlmEvaluation = this.shouldFlagForLlm(
      claim,
      conflictCount,
      final,
    );

    return {
      score: final,
      factors: {
        baseScore,
        certaintyModifier,
        conflictPenalty,
        inferenceDiscount,
        final,
        reasoning: '...',
      },
      needsLlmEvaluation,
    };
  }

  private getBaseScore(source?: ClaimSourceType): number {
    switch (source) {
      case 'direct':
        return 1.0;
      case 'attributed':
        return 0.8;
      case 'hearsay':
        return 0.5;
      default:
        return 0.7;
    }
  }

  private getCertaintyModifier(language?: string): number {
    if (!language) return 1.0;
    const lower = language.toLowerCase();
    if (lower.includes('definitely') || lower.includes('certainly')) return 1.0;
    if (lower.includes('probably') || lower.includes('likely')) return 0.9;
    if (lower.includes('think') || lower.includes('believe')) return 0.7;
    if (lower.includes('maybe') || lower.includes('might')) return 0.5;
    return 0.8;
  }

  private getInferenceDiscount(method?: string): number {
    switch (method) {
      case 'direct':
        return 1.0;
      case 'logical_inference':
        return 0.9;
      case 'llm_inference':
        return 0.8;
      default:
        return 1.0;
    }
  }

  private shouldFlagForLlm(
    claim: ExtractedClaim,
    conflictCount: number,
    score: number,
  ): boolean {
    return (
      conflictCount > 0 || claim.claimedBySource === 'hearsay' || score < 0.6
    );
  }
}
```

### 3.4 MergeHandlerService

**Purpose**: Handle entity merge and unmerge operations.

```typescript
export class MergeHandlerService {
  constructor(
    private entityMergeRepo: EntityMergeRepository,
    private personRepo: PersonRepository,
    private placeRepo: PlaceRepository,
    // ... other entity repos
  ) {}

  async mergeEntities(
    familyId: string,
    sourceEntityId: string,
    targetEntityId: string,
    entityType: 'person' | 'place' | 'event' | 'story',
    options: {
      strategy: string;
      confidence: number;
      triggerEventId: string;
      reason: string;
    },
  ): Promise<EntityMerge> {
    // 1. Create merge record
    const merge = await this.entityMergeRepo.create({
      familyId,
      sourceEntityId,
      sourceEntityType: entityType,
      targetEntityId,
      targetEntityType: entityType,
      mergeStrategy: options.strategy,
      confidence: options.confidence,
      triggerEventId: options.triggerEventId,
      mergedBy: 'registrar',
      mergeReason: options.reason,
    });

    // 2. Update superseded_by on source entity
    await this.markSuperseded(
      familyId,
      sourceEntityId,
      targetEntityId,
      entityType,
    );

    return merge;
  }

  async deleteMerge(familyId: string, mergeId: string): Promise<void> {
    const merge = await this.entityMergeRepo.findById(familyId, mergeId);
    if (!merge) return;

    // 1. Clear superseded_by on source entity
    const repo = this.getRepoForType(merge.sourceEntityType);
    await repo.update(familyId, merge.sourceEntityId, {
      supersededBy: null,
      supersededAt: null,
    });

    // 2. Delete the merge record
    await this.entityMergeRepo.delete(familyId, mergeId);
  }

  private async markSuperseded(
    familyId: string,
    sourceId: string,
    targetId: string,
    entityType: string,
  ): Promise<void> {
    const repo = this.getRepoForType(entityType);
    await repo.update(familyId, sourceId, {
      supersededBy: targetId,
      supersededAt: new Date(),
    });
  }
}
```

### 3.5 Simplified Registrar Orchestrator

```typescript
export class RegistrarAgent {
  constructor(
    private entityMatcher: EntityMatcherService,
    private conflictDetector: ConflictDetectorService,
    private strengthCalculator: StrengthCalculatorService,
    private mergeHandler: MergeHandlerService,
    private dataRetriever: DataRetrieverService,
    // Repositories for persistence
    private personRepo: PersonRepository,
    private claimRepo: ClaimRepository,
    private claimEntityRepo: ClaimEntityRepository,
    private claimRelationshipRepo: ClaimRelationshipRepository,
    // ... other repos
  ) {}

  async persist(domainModel: ScribeDomainModel, familyId: string): Promise<void> {
    const sourceEventId = domainModel.sourceEventId;
    const personIdMap = new Map<string, string>();
    const placeIdMap = new Map<string, string>();

    // 1. Process People
    for (const person of domainModel.people) {
      const matchResult = await this.entityMatcher.matchPerson(familyId, person);

      if (matchResult.matched) {
        personIdMap.set(person.name, matchResult.existingEntityId!);
        // Add new aliases if any
        if (matchResult.suggestedAliases?.length) {
          await this.personRepo.addAliases(familyId, matchResult.existingEntityId!, matchResult.suggestedAliases);
        }
      } else {
        const newPerson = await this.personRepo.insert({ familyId, ...person });
        personIdMap.set(person.name, newPerson.id);
      }
    }

    // 2. Process Places (similar pattern)
    for (const place of domainModel.places) {
      const matchResult = await this.entityMatcher.matchPlace(familyId, place);
      // ... similar logic
    }

    // 3. Process Claims
    for (const claim of domainModel.claims) {
      // Detect conflicts
      const conflicts = await this.conflictDetector.detectConflicts(familyId, claim);

      // Calculate strength
      const strength = this.strengthCalculator.calculate(claim, conflicts.length);

      // Create claim
      const newClaim = await this.claimRepo.insert({
        familyId,
        ...claim,
        claimStrength: strength.score,
        strengthFactors: strength.factors,
        needsLlmEvaluation: strength.needsLlmEvaluation,
        sourceEventId,
      });

      // Link entities via claim_entities
      await this.linkClaimEntities(familyId, newClaim.id, claim, personIdMap, placeIdMap);

      // Create conflict relationships
      for (const conflict of conflicts) {
        await this.claimRelationshipRepo.create({
          familyId,
          claimId: newClaim.id,
          relatedClaimId: conflict.conflictingClaimId!,
          relationshipType: conflict.conflictType!,
        });
      }

      // Handle identity claims
      if (claim.claimType === 'identity') {
        await this.handleIdentityClaim(familyId, claim, newClaim.id, personIdMap, sourceEventId);
      }
    }

    // 4. Process Events, Stories, Relationships, Questions, Answers
    // ... (use join tables: event_participants, story_entities)
  }

  private async linkClaimEntities(...): Promise<void>;
  private async handleIdentityClaim(...): Promise<void>;
}
```

### Files to Create/Modify

| File                                                            | Action                    |
| --------------------------------------------------------------- | ------------------------- |
| `libs/agents/registrar/src/lib/services/entity-matcher.ts`      | Create                    |
| `libs/agents/registrar/src/lib/services/conflict-detector.ts`   | Create                    |
| `libs/agents/registrar/src/lib/services/strength-calculator.ts` | Create                    |
| `libs/agents/registrar/src/lib/services/merge-handler.ts`       | Create                    |
| `libs/agents/registrar/src/lib/services/index.ts`               | Create                    |
| `libs/agents/registrar/src/lib/registrar.ts`                    | Refactor to use services  |
| `libs/agents/registrar/src/lib/conflict-detector.ts`            | Delete (moved to service) |

---

## 4. Historian Agent (`libs/agents/historian`)

**Status: ⚠️ MINOR CHANGES**

Historian uses the shared DataRetriever instead of its own retrieval logic.

### Changes

```typescript
// Before (in historian's retriever.ts)
const claims = await this.claimRepo.findByEntity(familyId, 'person', personId);

// After (using shared DataRetriever)
const claims = await this.dataRetriever.getClaimsForEntityIncludingMerged(
  familyId,
  personId,
  'person',
);
```

### Files to Modify

| File                                         | Changes                                           |
| -------------------------------------------- | ------------------------------------------------- |
| `libs/agents/historian/src/lib/retriever.ts` | Use shared DataRetriever, move common logic there |
| `libs/agents/historian/src/lib/historian.ts` | Inject DataRetrieverService                       |

---

## 5. Ingester / Message Queue (`libs/queue`)

**Status: ⚠️ MINOR CHANGES**

Add ingestion batch tracking.

### Changes

```typescript
// At batch start
const batch = await this.ingestionBatchRepo.create({
  familyId,
  source: 'telegram',
  ingestionStartedAt: new Date(),
  status: 'in_progress',
});

// For each event
event.ingestionBatchId = batch.id;

// At batch end
await this.ingestionBatchRepo.complete(batch.id, eventCount);
```

### Files to Modify

| File                  | Changes                       |
| --------------------- | ----------------------------- |
| Ingestion entry point | Add batch creation/completion |

---

## 6. Other Agents

| Agent           | Status                            |
| --------------- | --------------------------------- |
| **Intern**      | ✅ No changes - routes messages   |
| **Admin**       | ✅ No changes - handles commands  |
| **Facilitator** | ✅ No changes - formats responses |
| **Curator**     | ✅ No changes - currently stub    |

---

## 7. New Repository Files

| File                               | Purpose                                  |
| ---------------------------------- | ---------------------------------------- |
| `entity-merge-repository.ts`       | CRUD for `entity_merges`                 |
| `identity-claim-repository.ts`     | CRUD for `identity_claims`               |
| `claim-entity-repository.ts`       | CRUD for `claim_entities` join table     |
| `claim-relationship-repository.ts` | CRUD for `claim_relationships`           |
| `story-entity-repository.ts`       | CRUD for `story_entities` join table     |
| `event-participant-repository.ts`  | CRUD for `event_participants` join table |
| `ingestion-batch-repository.ts`    | CRUD for `ingestion_batches`             |

---

## 8. Type Definition Changes

### `libs/shared/types/src/lib/domain-model.ts`

| Type             | Changes                                                       |
| ---------------- | ------------------------------------------------------------- |
| `ExtractedClaim` | Add `inferenceMethod`, `referencedPeople`, `referencedPlaces` |

### `libs/shared/types/src/lib/entities.ts`

| Type            | Changes                                                                         |
| --------------- | ------------------------------------------------------------------------------- |
| `Person`        | Add `supersededBy`, `supersededAt`                                              |
| `Place`         | Add `supersededBy`, `supersededAt`                                              |
| `TimelineEvent` | Add `supersededBy`, `supersededAt`                                              |
| `Story`         | Add `supersededBy`, `supersededAt`                                              |
| `Claim`         | Add `claimStrength`, `strengthFactors`, `needsLlmEvaluation`, `inferenceMethod` |

### New Types

| Type                | Purpose                                      |
| ------------------- | -------------------------------------------- |
| `EntityMerge`       | Active merge record (deletable to undo)      |
| `IdentityClaim`     | Tracks descriptive→canonical name resolution |
| `ClaimEntity`       | Many-to-many claim↔entity                   |
| `ClaimRelationship` | Claim conflict/support relationships         |
| `StoryEntity`       | Many-to-many story↔entity                   |
| `EventParticipant`  | Many-to-many event↔entity                   |
| `IngestionBatch`    | Batch tracking                               |
| `StrengthFactors`   | Claim strength breakdown                     |
| `MatchResult`       | Entity matching result                       |
| `ConflictResult`    | Conflict detection result                    |

---

## Migration Strategy

### Phase 1: Database + Types + Repositories

1. Run database migrations (additive, non-breaking)
2. Update type definitions
3. Create new repository files
4. Create DataRetrieverService (extract from Historian)

### Phase 2: Registrar Services

1. Create StrengthCalculatorService (new, no dependencies)
2. Create EntityMatcherService (uses DataRetriever)
3. Create ConflictDetectorService (uses DataRetriever)
4. Create MergeHandlerService (uses repos)

### Phase 3: Registrar Refactor

1. Refactor Registrar to use services
2. Update to use join tables
3. Delete old conflict-detector.ts
4. Test persistence flow

### Phase 4: Historian + Scribe + Testing

1. Update Historian to use shared DataRetriever
2. Minor Scribe output updates
3. End-to-end testing
4. Verify backwards compatibility

---

## Testing Strategy

### Unit Tests

| Service                     | Test Focus                                                |
| --------------------------- | --------------------------------------------------------- |
| `EntityMatcherService`      | Exact match, alias match, fuzzy match, no match           |
| `ConflictDetectorService`   | Value conflicts, no conflicts, semantic conflicts         |
| `StrengthCalculatorService` | All source types, certainty modifiers, conflict penalties |
| `MergeHandlerService`       | Merge creation, superseded_by updates                     |
| `DataRetrieverService`      | Context retrieval, merge chain queries                    |

### Integration Tests

- Registrar + services + repositories
- Historian + DataRetriever
- End-to-end: message → Scribe → Registrar → query via Historian

---

## Risks & Mitigations

| Risk                                    | Mitigation                                           |
| --------------------------------------- | ---------------------------------------------------- |
| Service extraction breaks existing flow | Incremental refactor; keep old code until new tested |
| DataRetriever becomes bottleneck        | Cache frequently accessed data; optimize queries     |
| LLM calls in services add latency       | Make LLM optional; use only for uncertain cases      |
| Test coverage gaps                      | Write service tests before refactoring Registrar     |

---

## Summary: Component Responsibilities

| Component                     | Responsibility                                             |
| ----------------------------- | ---------------------------------------------------------- |
| **Scribe**                    | Extract structured data from text (language understanding) |
| **Registrar**                 | Orchestrate persistence, delegate to services              |
| **EntityMatcherService**      | Decide if extracted entity matches existing                |
| **ConflictDetectorService**   | Detect claim conflicts                                     |
| **StrengthCalculatorService** | Calculate claim strength from signals                      |
| **MergeHandlerService**       | Handle entity merge and unmerge operations                 |
| **DataRetrieverService**      | Shared retrieval logic (used by Registrar + Historian)     |
| **Historian**                 | Answer questions using DataRetriever                       |
| **Repositories**              | CRUD operations (persistence only)                         |

---

## Related Documents

- [Data Architecture Redesign](./2026-01-21-data-architecture-redesign.md) - Schema changes and migration details
- [Data Integrity & Testing Plan](./2026-01-21-data-integrity-testing.md) - Validation queries and replay tooling
- [Entity Resolution Architecture](./2026-01-16-entity-resolution-architecture.md) - Background research (superseded)

---

## Future Considerations

### Scribe Output Storage (for Replay Testing)

The [Data Integrity & Testing Plan](./2026-01-21-data-integrity-testing.md) recommends storing Scribe's domain model output to enable deterministic replay testing of Registrar changes. This is not required for the initial implementation but should be considered for Phase 2:

**Option A**: Add `scribe_output JSONB` column to `conversation_events`
**Option B**: Create separate `scribe_outputs` table with FK to `conversation_events`

This would enable:

- Registrar-only replay (deterministic, no LLM cost)
- Debugging specific extraction issues
- A/B testing Registrar changes before deployment
