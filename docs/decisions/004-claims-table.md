# ADR-004: Claims Table (Not Direct Facts)

## Status

Accepted

## Date

2026-01-10

## Context

Family members disagree about facts:

- "Arrived 1889" vs "Arrived 1891"
- "Warsaw" vs "outside Warsaw"

Need to preserve ALL versions without auto-resolving.

## Decision

Create `claims` table where every fact is a claim with:

- Source (who said it)
- Confidence level
- Certainty language ("definitely" vs "I think")
- Links to conflicting claims

## Consequences

### Positive

- Clear provenance for every fact
- Easy to detect and preserve conflicts
- Can track confidence and uncertainty
- Audit trail for everything

### Negative

- More complex than single facts table
- Queries need to handle multiple claims

### Trade-off

Data integrity worth the complexity
