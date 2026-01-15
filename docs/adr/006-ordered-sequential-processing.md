# ADR-006: Ordered Sequential Processing

## Status

Accepted

## Date

2026-01-10

## Context

Messages arrive in sequence, context matters:

- "My grandfather" then "He ran a shop" - "He" refers to grandfather
- Processing out of order breaks context

## Decision

Use ordered queue, process one message at a time sequentially.

## Consequences

### Positive

- Context preserved
- Correct entity resolution
- Simpler reasoning

### Negative

- Slower than parallel processing
- Can't scale horizontally easily

### Trade-off

Correctness > throughput (for now)
