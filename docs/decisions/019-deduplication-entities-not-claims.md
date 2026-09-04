# ADR-019: Deduplication Applies Only to Entities, Not Claims

## Status

Accepted

## Date

2026-01-10

## Context

Multiple people may assert different facts about the same event.
Automatically merging or deduplicating these assertions would erase family memory differences.

## Decision

Deduplication is applied only to entity identity (people, places, events).
Claims are never deduplicated or merged; conflicting claims are preserved and linked.

## Consequences

### Positive

- Preserves divergent memories
- Maintains provenance
- Avoids false certainty

### Negative

- More data to manage

### Trade-off

Historical integrity over simplification
