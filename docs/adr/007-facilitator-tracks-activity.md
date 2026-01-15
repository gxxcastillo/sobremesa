# ADR-007: Facilitator Tracks Activity, Not Content

## Status

Accepted

## Date

2026-01-10

## Context

Need to detect:

- Active conversations (don't interrupt)
- Silence (re-engage)

But don't want duplicate content processing.

## Decision

Facilitator gets lightweight activity stream:

- Timestamps, sender IDs, message counts
- Does NOT get message content
- Scribe handles all content processing

## Consequences

### Positive

- Clear separation of concerns
- No duplicate processing
- Facilitator stays lightweight

### Negative

- Can't make content-based decisions

### Trade-off

Worth it for clean architecture
