# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for Sobremesa.

## Index

| ADR                                               | Title                                                  | Status                         | Date       |
| ------------------------------------------------- | ------------------------------------------------------ | ------------------------------ | ---------- |
| [001](001-family-tree-traversal.md)               | Family Tree Traversal Service                          | Proposed                       | 2026-01-12 |
| [002](002-configurable-library.md)                | Configurable Library (Not Single-Family App)           | Accepted                       | 2026-01-10 |
| [003](003-original-language-storage.md)           | Original Language Storage with Translate-on-Read       | Accepted                       | 2026-01-10 |
| [004](004-claims-table.md)                        | Claims Table (Not Direct Facts)                        | Accepted                       | 2026-01-10 |
| [005](005-single-writer-pattern.md)               | Single Writer Pattern                                  | Accepted                       | 2026-01-10 |
| [006](006-ordered-sequential-processing.md)       | Ordered Sequential Processing                          | Accepted                       | 2026-01-10 |
| [007](007-facilitator-tracks-activity.md)         | Facilitator Tracks Activity, Not Content               | Accepted (implementation note) | 2026-01-10 |
| [008](008-event-log-audit.md)                     | Event Log for Complete Audit                           | Accepted                       | 2026-01-10 |
| [009](009-redaction-system.md)                    | Redaction System (Soft + Hard Delete)                  | Accepted                       | 2026-01-10 |
| [010](010-pluggable-chat-provider.md)             | Pluggable Chat Provider                                | Accepted                       | 2026-01-10 |
| [011](011-supabase-database.md)                   | Supabase for Database                                  | Accepted                       | 2026-01-10 |
| [012](012-async-media-processing.md)              | Async Media Processing                                 | Accepted (implementation note) | 2026-01-10 |
| [013](013-scribe-detects-answers.md)              | Scribe Detects Answers (Not Facilitator)               | Superseded                     | 2026-01-10 |
| [014](014-minimal-configuration-levers.md)        | Minimal Configuration Levers (MVP)                     | Accepted                       | 2026-01-10 |
| [015](015-cultural-terms-never-translated.md)     | Cultural Terms Never Translated                        | Accepted                       | 2026-01-10 |
| [016](016-warmth-non-negotiable.md)               | Warmth as Non-Negotiable Product Requirement           | Accepted                       | 2026-01-10 |
| [017](017-family-scoped-data.md)                  | Family-Scoped Data Model                               | Accepted                       | 2026-01-10 |
| [018](018-question-lifecycle.md)                  | Question Lifecycle as a First-Class Entity             | Accepted                       | 2026-01-10 |
| [019](019-deduplication-entities-not-claims.md)   | Deduplication Applies Only to Entities, Not Claims     | Accepted                       | 2026-01-10 |
| [020](020-catalog-human-questions.md)             | Catalog Human-Asked Questions Without System Re-Asking | Proposed                       | 2026-01-10 |
| [021](021-one-bot-per-family.md)                  | One Bot Instance Per Family                            | Superseded                     | 2026-01-10 |
| [022](022-intern-agent-haiku.md)                  | Intern Agent for Lightweight Preprocessing (Haiku)     | Accepted                       | 2026-01-12 |
| [023](023-domain-model-augmentation.md)           | Domain Model Augmentation Pattern                      | Accepted                       | 2026-01-12 |
| [024](024-historian-returns-facilitator-sends.md) | Historian Returns Answers, Facilitator Sends           | Accepted                       | 2026-01-15 |
| [025](025-claims-based-data-architecture.md)      | Claims-Based Data Architecture                         | Accepted                       | 2026-01-21 |
| [026](026-llm-evaluation-queue.md)                | LLM Evaluation Queue Architecture                      | Accepted (implementation note) | 2026-01-26 |
| [027](027-hybrid-claim-strength-scoring.md)       | Hybrid Claim Strength Scoring                          | Accepted                       | 2026-01-26 |
| [028](028-data-quality-extraction-rules.md)       | Data Quality Extraction Rules                          | Accepted                       | 2026-01-27 |
| [029](029-multi-tenant-single-bot-process.md)     | Multi-Tenant Single Bot Process                        | Accepted                       | 2026-07-02 |

## Key Architectural Themes

1. **Configurability** - Work for any family, any culture, any language
2. **Data Integrity** - Claims-based, conflict preservation, provenance
3. **Warmth First** - Core mechanism, not optional
4. **Clean Separation** - Each component focused, single writer
5. **Audit Everything** - Event log, complete trail
6. **Privacy Respect** - Redaction, GDPR compliance
7. **Practical Tradeoffs** - Correctness > speed, quality > throughput

_Removed 2026-07-02 as aspirational/unbuilt: "Adaptive Intelligence - Coach monitors and
optimizes" (no coaching worker exists) and the blockchain option under audit (never built, no ADR
proposes it)._

## Queued ADRs

Decisions expected but not yet made/written:

- "Provenance is stamped by the pipeline, never inferred by the model."
- "Single-instance by design until N families."

## ADR Format

Each ADR follows this structure:

```markdown
# ADR-XXX: Title

## Status

Proposed | Accepted | Deprecated | Superseded

## Date

YYYY-MM-DD

## Context

What problem are we solving?

## Decision

What did we decide?

## Consequences

### Positive

- Benefits

### Negative

- Drawbacks

### Trade-off

Summary of the trade-off
```

## Creating New ADRs

1. Create a new file: `docs/adr/XXX-short-title.md`
2. Use the next available number
3. Follow the format above
4. Update this README index

An ADR records a decision that was made and acted on. When implementation departs from an ADR,
don't rewrite its Context/Decision/Consequences — mark it Superseded with a dated note under
`## Status`, and if a real decision replaced it, record that decision as a new ADR.
