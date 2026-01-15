# ADR-008: Event Log for Complete Audit

## Status

Accepted

## Date

2026-01-10

## Context

Need to:

- Debug issues ("why didn't it ask?")
- Track system behavior
- Provide analytics
- Audit all actions

## Decision

Create comprehensive event log:

- All decisions (asked/didn't ask question)
- All rule changes (coaching adjustments)
- All conflicts detected
- All system events

## Consequences

### Positive

- Complete audit trail
- Debugging power
- Analytics capability
- Transparency

### Negative

- Storage overhead

### Trade-off

Worth it for production system
