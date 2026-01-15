# ADR-017: Family-Scoped Data Model

## Status

Accepted

## Date

2026-01-10

## Context

Sobremesa is designed to preserve the history of individual families.
Multiple families may use the system, but their data must remain fully isolated:

- No cross-family deduplication
- No shared timelines or entities
- No accidental data bleed

## Decision

All persisted data is scoped by `family_id`:

- Every content and system table includes `family_id`
- All reads, writes, and deduplication are constrained within a family
- Queues, coaching rules, and configuration are all family-specific

## Consequences

### Positive

- Strong isolation guarantees
- Clear domain boundary
- Prevents cross-family data corruption

### Negative

- Slightly more verbose schema and queries

### Trade-off

Safety and clarity outweigh minimal complexity
