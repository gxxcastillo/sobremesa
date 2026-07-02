# ADR-012: Async Media Processing

## Status

Accepted

**Implementation status (2026-07-02):** Image records are created asynchronously as designed, but
no consumer currently runs Curator analysis on them in the live `chatbots` app — the
`onImageCreated` hook exists but is never registered. Wiring a Curator consumer onto that hook is
open work.

## Date

2026-01-10

## Context

Photo analysis takes time. Don't want to:

- Block text message processing
- Make family wait for response
- Lose message order

## Decision

Process media asynchronously:

- Text Scribe detects image
- Delegates to Curator (background)
- Continues processing text
- Media results feed back when ready

## Consequences

### Positive

- Don't block text flow
- Better user experience
- Can process multiple images in parallel

### Negative

- More complex architecture

### Trade-off

Worth it for responsiveness
