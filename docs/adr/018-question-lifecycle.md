# ADR-018: Question Lifecycle as a First-Class Entity

## Status

Accepted

## Date

2026-01-10

## Context

Collecting family history requires asking questions carefully and at the right time.
Questions are not just messages — they have:

- Intent
- Timing constraints
- Outcomes (answered, ignored, retired)

Multiple agents participate in the process.

## Decision

Questions are treated as first-class entities with a lifecycle:

- Scribe and Curator propose questions
- Facilitator decides if/when to ask and applies warmth formula via AI
- Scribe detects answers
- Registrar persists state changes
- Admin adapts behavior based on outcomes

## Consequences

### Positive

- Clear separation of responsibilities
- Better timing and warmth
- Enables analytics and coaching

### Negative

- Additional table and complexity

### Trade-off

Improves data quality and user trust
