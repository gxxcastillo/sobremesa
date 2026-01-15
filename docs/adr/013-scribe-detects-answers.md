# ADR-013: Scribe Detects Answers (Not Facilitator)

## Status

Accepted

## Date

2026-01-10

## Context

Who checks if message answers pending question?

## Decision

Scribe handles answer detection:

- Already processing all message content
- Has context of questions
- Natural fit

## Consequences

### Positive

- Single content processor
- Avoids duplicate work
- Scribe has full context

### Negative

- Scribe slightly larger

### Trade-off

Clean separation
