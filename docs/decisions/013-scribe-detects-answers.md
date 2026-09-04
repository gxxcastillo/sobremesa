# ADR-013: Scribe Detects Answers (Not Facilitator)

## Status

Superseded

**2026-07-02:** Superseded. Answer detection is implemented as deterministic reply-matching in the
queue processor (`detectAndMarkAnswer` in `libs/queue/src/lib/processor.ts`, triggered by
`externalReplyToId`), not inside the Scribe agent. See
[`spec/message-lifecycle.md`](../../spec/message-lifecycle.md) §4.4 for current behavior.

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
