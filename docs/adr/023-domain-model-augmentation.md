# ADR-023: Domain Model Augmentation Pattern

## Status

Accepted

## Date

2026-01-12

## Context

Scribe extracts domain models from messages, but may miss certain patterns (e.g., image references). Need a way for other agents to enhance the domain model without duplicating Scribe's work.

## Decision

Implement domain model augmentation pattern:

1. Scribe produces initial domain model
2. Subsequent agents (e.g., Intern image linker) can add to the model
3. Registrar receives the final augmented model
4. Augmentations are marked with lower confidence (e.g., `MEDIUM` vs Scribe's `HIGH`)

### Implementation

```typescript
// If Scribe missed image reference, Intern adds it
if (!alreadyDetected) {
  domainModel.imageReferences = [
    ...existingRefs,
    {
      imageId: linkResult.imageId,
      referenceType: linkResult.referenceType,
      confidence: Confidence.MEDIUM, // Lower than Scribe
    },
  ];
}
```

## Consequences

### Positive

- Specialized agents can improve extraction quality
- Clear confidence attribution (who detected what)
- Extensible for future augmentation agents
- No modification of Scribe code required

### Negative

- Requires careful coordination of agent execution order

### Trade-off

Flexibility worth the orchestration complexity
