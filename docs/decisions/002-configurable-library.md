# ADR-002: Configurable Library (Not Single-Family App)

## Status

Accepted

## Date

2026-01-10

## Context

Initial design was specific to one Nicaraguan family (Spanish/English, Carmencita, La Directora). Need to make reusable for ANY family.

## Decision

Build as configurable library:

- Internal code uses generic role names (`BotRole.FACILITATOR`)
- Configuration provides display names ("Carmencita", "Annie", "Yui")
- All personality traits configurable
- Language support configurable (any primary + secondaries)

## Consequences

### Positive

- Reusable product, can serve many families
- Forces clean architecture (separation of concerns)
- Can adapt to different cultures and languages

### Negative

- More complex than single-family app
- Must test with multiple configurations
