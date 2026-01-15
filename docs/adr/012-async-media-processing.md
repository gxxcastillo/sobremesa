# ADR-012: Async Media Processing

## Status

Accepted

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
