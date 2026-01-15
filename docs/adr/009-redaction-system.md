# ADR-009: Redaction System (Soft + Hard Delete)

## Status

Accepted

## Date

2026-01-10

## Context

Mistakes happen:

- Someone shares SSN by accident
- Family wants to remove embarrassing story
- GDPR "right to be forgotten"

## Decision

Two-tier redaction:

### Soft Delete (Default)

- Mark as redacted
- Keep for audit
- Cascade to derived claims

### Hard Delete (GDPR)

- Permanently remove
- Log intention first
- Break audit trail (necessary)

## Consequences

### Positive

- Privacy protection
- GDPR compliance
- Mistake recovery

### Negative

- Complexity

### Trade-off

Legal requirement, must have
