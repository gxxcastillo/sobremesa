# Service Layer Architecture

**Service layer for business logic extraction and testable components.**

---

## Overview

The service layer extracts business logic from agents into reusable, testable services. This enables:

- Clear separation of orchestration (Registrar) from business logic (services)
- Unit testing of complex algorithms without mocking repositories
- Shared patterns across agents (e.g., DataRetrieverService used by Registrar and Historian)
- Easier maintenance and evolution of business rules

## Architecture Pattern

```
Agent (Orchestrator)
    │
    ├── BusinessLogicService 1
    ├── BusinessLogicService 2
    └── BusinessLogicService 3
          │
          ▼
    DataRetrieverService (Shared)
          │
          ▼
    Repositories (CRUD)
```

---

## Core Services

### EntityMatcherService

**Location:** `libs/agents/registrar/src/lib/services/entity-matcher.ts`

**Purpose:** Entity deduplication with fuzzy matching

**Methods:**

- `matchPerson(familyId, extractedPerson, existingPeople)` → `MatchResult`
- `matchPlace(familyId, extractedPlace, existingPlaces)` → `MatchResult`
- `matchEvent(familyId, extractedEvent, existingEvents)` → `MatchResult`

**Matching strategies:**

1. Exact name match
2. Alias match (check if name in aliases array)
3. Fuzzy match (Levenshtein distance < threshold)
4. Optional: LLM verification for uncertain matches (future)

**Match confidence:**

- `> 0.9` → Auto-merge (high confidence)
- `0.7 - 0.9` → Flag for manual review (medium confidence)
- `< 0.7` → Create separate entity (low confidence)

**Integration:**

```typescript
const match = await entityMatcherService.matchPerson(
  familyId,
  extractedPerson,
  existingPeople,
);

if (match.confidence >= 0.9) {
  await mergeHandlerService.merge(
    match.sourceId,
    match.targetId,
    'fuzzy_match',
  );
}
```

---

### ConflictDetectorService

**Location:** `libs/agents/registrar/src/lib/services/conflict-detector.ts`

**Purpose:** Detect and resolve conflicts between claims

**Methods:**

- `detectConflicts(familyId, newClaim, entityId?, entityType?)` → `ConflictResult[]`
- `resolveConflicts(newClaimStrength, existingClaims)` → `ResolutionAction`

**Conflict types:**

- `contradicts` - Mutually exclusive values (birth year 1920 vs 1922)
- `refines` - More specific version (birth year vs exact birth date)
- `supports` - Confirms existing claim

**Resolution strategy:**

```typescript
if (newStrength > existingStrength + 0.2) {
  return { action: 'supersede_existing', supersededClaimIds: [...] };
} else if (existingStrength > newStrength + 0.2) {
  return { action: 'mark_disputed', reason: 'existing_much_stronger' };
} else {
  return { action: 'mark_disputed', reason: 'similar_strength' };
}
```

**Entity-aware conflict detection:**

- Only checks claims linked to the same entity via `claim_entities` join table
- Prevents false conflicts between different people with same name
- Requires `entityId` and `entityType` parameters for entity scoping

**Integration:**

```typescript
const conflicts = await conflictDetectorService.detectConflicts(
  familyId,
  newClaim,
  personId, // Entity ID (optional, for scoped detection)
  'person', // Entity type (optional)
);

const resolution = conflictDetectorService.resolveConflicts(
  newClaimStrength,
  conflicts.map((c) => ({
    claimId: c.conflictingClaimId,
    claimStrength: c.strength,
  })),
);

if (resolution.action === 'supersede_existing') {
  for (const claimId of resolution.supersededClaimIds) {
    await claimRepo.markSuperseded(familyId, claimId);
  }
}
```

---

### StrengthCalculatorService

**Location:** `libs/agents/registrar/src/lib/services/strength-calculator.ts`

**Purpose:** Hybrid scoring (algorithmic + selective LLM evaluation)

**Methods:**

- `calculate(claim, conflictCount, isHighStakes)` → `StrengthResult`
- `isHighStakesClaim(claimType, claimValue)` → `boolean`

**Algorithmic scoring:**

```
Base score by source:
- direct: 1.0
- attributed: 0.8
- hearsay: 0.5

Certainty modifier:
- "definitely": 1.0
- "probably": 0.9
- "I think": 0.7
- "might": 0.6

Conflict penalty: 0.8 per conflict (multiplicative)

Final = baseScore × certaintyModifier × conflictPenalty
```

**LLM evaluation triggers:**

- Has conflicts
- Uncertainty language ("think", "maybe", "probably")
- Hearsay source
- High-stakes claim (birth/death dates, legal relationships)
- Low initial score (< 0.6)

**Integration:**

```typescript
const isHighStakes = strengthCalculatorService.isHighStakesClaim(
  claim.claimType,
  claim.claimValue,
);

const strengthResult = strengthCalculatorService.calculate(
  claim,
  conflictCount,
  isHighStakes,
);

const newClaim = await claimRepo.createFromExtracted(
  familyId,
  claim,
  sourceEventId,
  claimedBy,
  {
    claimStrength: strengthResult.score,
    strengthFactors: strengthResult.factors,
    needsLlmEvaluation: strengthResult.needsLlmEvaluation,
  },
);

if (strengthResult.needsLlmEvaluation) {
  await llmQueueRepo.enqueue(familyId, 'claim_strength', 'claim', newClaim.id, {
    priority: isHighStakes ? 100 : 0,
  });
}
```

---

### MergeHandlerService

**Location:** `libs/agents/registrar/src/lib/services/merge-handler.ts`

**Purpose:** Entity merge and unmerge operations

**Methods:**

- `merge(familyId, sourceEntityId, targetEntityId, strategy, confidence)` → `EntityMerge`
- `unmerge(familyId, mergeId)` → `void`
- `getMergeChain(familyId, entityId, entityType)` → `UUID[]`

**Merge workflow:**

1. Create `entity_merges` record
2. Update target entity (add source name to aliases)
3. Mark source entity as superseded (`superseded_by = targetId`)
4. For identity claims: Update `claim_entities` with `resolved = TRUE`, `entity_merge_id`

**Unmerge workflow:**

1. Delete `entity_merges` record
2. Clear `superseded_by` on source entity
3. For identity claims: Set `claim_entities.resolved = FALSE`, `entity_merge_id = NULL`
4. Claims remain intact (provenance preserved)

**Integration:**

```typescript
await mergeHandlerService.merge(
  familyId,
  sourcePersonId,
  targetPersonId,
  'identity_claim',
  1.0,
);

// Later, to undo:
await mergeHandlerService.unmerge(familyId, mergeId);
```

---

### DataRetrieverService

**Location:** `libs/database/src/lib/services/data-retriever.ts`

**Purpose:** Shared data retrieval patterns used by multiple agents

**Methods:**

- `getPersonContext(familyId, personIds)` → `Person[]`
- `getClaimContext(familyId, entityId, entityType)` → `Claim[]`
- `getRecentConversationContext(familyId, conversationId, limit)` → `ConversationEvent[]`

**Shared by:**

- Registrar: Load context for entity matching and conflict detection
- Historian: Load context for answering questions

**Benefits:**

- Single source of truth for common queries
- Consistent data fetching patterns
- Easier to optimize (e.g., add caching)

**Integration:**

```typescript
// In Registrar
const existingPeople = await dataRetrieverService.getPersonContext(
  familyId,
  personIds,
);

const claims = await dataRetrieverService.getClaimContext(
  familyId,
  personId,
  'person',
);

// In Historian
const context = await dataRetrieverService.getRecentConversationContext(
  familyId,
  conversationId,
  10,
);
```

---

## Testing Patterns

### Unit Tests for Services

Services are pure business logic, easy to unit test:

```typescript
describe('StrengthCalculatorService', () => {
  it('calculates strength for direct claim with no conflicts', () => {
    const result = service.calculate(
      { claimedBySource: 'direct', certaintyLanguage: 'definitely' },
      0, // no conflicts
      false, // not high stakes
    );

    expect(result.score).toBe(1.0);
    expect(result.needsLlmEvaluation).toBe(false);
  });

  it('flags hearsay claims for LLM evaluation', () => {
    const result = service.calculate(
      { claimedBySource: 'hearsay', certaintyLanguage: null },
      0,
      false,
    );

    expect(result.needsLlmEvaluation).toBe(true);
    expect(result.factors.evaluationTriggered).toContain('hearsaySource');
  });
});
```

### Integration Tests with Repositories

Test service + repository integration:

```typescript
describe('EntityMatcherService integration', () => {
  it('matches person by alias', async () => {
    const existingPerson = await personRepo.createNew(familyId, {
      name: 'Maria Garcia',
      aliases: { en: ['Maria G.'] },
    });

    const match = await entityMatcherService.matchPerson(
      familyId,
      { name: 'Maria G.' },
      [existingPerson],
    );

    expect(match.confidence).toBeGreaterThan(0.9);
    expect(match.targetId).toBe(existingPerson.id);
  });
});
```

---

## Future Enhancements

### ClaimAggregatorService

**Purpose:** Aggregate claims into entity fields (materialized views)

**Methods:**

- `aggregatePersonData(familyId, personId)` → `AggregatedData`
- `updatePersonFields(familyId, personId)` → `void`

**Example:**

```typescript
const aggregated = await claimAggregatorService.aggregatePersonData(
  familyId,
  personId,
);
// {
//   birthYear: { value: 1920, confidence: 0.95, claimCount: 3 },
//   birthPlace: { value: 'Porto', confidence: 0.85, claimCount: 2 }
// }

await personRepo.update(familyId, personId, {
  birthYear: aggregated.birthYear.value,
  birthYearConfidence: aggregated.birthYear.confidence,
});
```

### InferenceEngineService

**Purpose:** Generate inferred claims from direct claims

**Methods:**

- `generateInferences(claim, claimedBy)` → `InferredClaim[]`

**Example:**

```typescript
// Direct claim: "Maria married José in 1920"
const inferences = inferenceEngineService.generateInferences(marriageClaim, claimedBy);
// [
//   { subject: "Maria's last name", claimValue: "José's last name", inferenceMethod: 'logical_inference' }
// ]

for (const inference of inferences) {
  const inferredClaim = await claimRepo.createFromExtracted(..., {
    inferenceMethod: 'logical_inference'
  });

  await claimRelationshipRepo.create({
    claimId: inferredClaim.id,
    relatedClaimId: marriageClaim.id,
    relationshipType: 'derived_from'
  });
}
```

---

## See Also

- [ARCHITECTURE.md](ARCHITECTURE.md) - System architecture overview
- [ADR-025](adr/025-claims-based-data-architecture.md) - Claims-based architecture decision
- [ADR-027](adr/027-hybrid-claim-strength-scoring.md) - Hybrid scoring approach
