# ADR-003: Original Language Storage with Translate-on-Read

## Status

Accepted

## Date

2026-01-10

## Context

Family is multi-lingual. Need to:

- Support code-switching (natural language mixing)
- Preserve what was actually said
- Make content accessible in any language
- Honor speaker's choice of language

## Decision

Store content in original language only:

- `content_original` - Exact words (sacred, never changed)
- `language_original` - ISO code of original language

Translations generated on-read when needed (not pre-computed).

## Consequences

### Positive

- Preserves authentic voice
- Simpler storage (no duplicate columns)
- No upfront translation API costs
- Can translate to any language on demand

### Negative

- Translation latency on read (can cache)

### Trade-off

Simplicity over pre-computation
