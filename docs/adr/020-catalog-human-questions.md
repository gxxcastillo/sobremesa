# ADR-020: Catalog Human-Asked Questions Without System Re-Asking

## Status

Proposed

**2026-07-02:** Reverted from Accepted — described behavior was never implemented; treat as
proposal. The `questions.origin` column and its `'curator' | 'human'` type support the schema, but
the pipeline's `GeneratedQuestion` type hardcodes `origin: 'curator'` and nothing captures a
human-asked question from chat or drives a follow-up.

## Date

2026-01-10

## Context

Family members naturally ask questions in conversation (e.g., "Who is in this photo?", "What year was that?"). These questions are valuable signals about gaps in family knowledge and often receive answers that should become claims. Human-origin questions are not placed into the Facilitator's normal outbound queue. However, if a human-origin question remains unanswered beyond a configurable delay, the Facilitator may post a single gentle follow-up (rate-limited, warmth-formula, and subject to real-time conversation/sensitivity checks). Human-origin questions are excluded from coaching "ignored question" metrics unless the Facilitator actually posts a follow-up.

## Decision

Store family-member questions in the `questions` table as first-class records, marked with `origin='human'` and attributed to the asking person/message. Human-origin questions:

- Are eligible for answer detection and claim generation
- Are linkable to stories/entities via context
- Are **never** placed into the Facilitator's outbound question queue
- Are excluded from coaching performance metrics (ignored/answered rates)

System-generated questions (from Scribe/Curator) continue to follow the standard lifecycle (proposed → asked → answered/retired).

## Consequences

### Positive

- Preserves organic family curiosity as part of history
- Improves provenance ("this answer responded to Aunt Sarah's question")
- Avoids duplicate or intrusive re-asking by the system
- Keeps coaching metrics clean and interpretable

### Negative

- Requires origin attribution and a small amount of filtering logic

### Trade-off

Slight added complexity for significantly better fidelity and user experience
