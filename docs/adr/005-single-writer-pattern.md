# ADR-005: Single Writer Pattern

## Status

Accepted

## Date

2026-01-10

## Context

Multiple agents need database access but:

- Race conditions possible
- Data integrity critical
- Audit trail required

## Decision

ONLY Registrar can modify core tables:

- Scribes output domain models
- Registrar maps to database schema
- All writes go through single component

## Consequences

### Positive

- No race conditions
- Clear responsibility
- Single point for validation
- Easy to audit

### Negative

- Bottleneck if volume is high

### Trade-off

Correctness > speed
