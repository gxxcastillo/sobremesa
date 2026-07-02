# Sobremesa Technical Specification

A specification of the Sobremesa system: an AI-powered family-history collection platform built as a
Bun + Nx monorepo. This spec is the canonical description of current system behavior.

## Two kinds of spec

- **Root files** (this list below) are **descriptive**: what the system does today. They are
  updated in the same change as code, per [`AGENTS.md`](../AGENTS.md).
- **[`spec/product/`](./product/)** is **normative**: what must be true regardless of
  implementation. It changes only by deliberate product decision, and such a change warrants an
  ADR (see [`docs/adr/`](../docs/adr/)).

## How to read this spec

Start with the overview, then dive into whichever area you need. Each file is self-contained and
cross-links the others.

| File                                                             | Use it for                                                                          |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [Overview](./overview.md)                                        | Purpose, runtime shape, monorepo layout, stack, configuration, system invariants    |
| [Data Model](./data-model.md)                                    | Claims, entities, relationships, table catalogue, queues, merges, immutability, RLS |
| [Agent Pipeline](./agent-pipeline.md)                            | Intern, Scribe, Registrar, Historian, Facilitator, Admin, Curator, model tiers      |
| [Message Lifecycle](./message-lifecycle.md)                      | Telegram ingestion, queue processing, outbound messages, questions, activation      |
| [AI Providers & Prompts](./ai-providers-and-prompts.md)          | Provider abstraction, model selection, prompts, structured output, token discipline |
| [Identity, Auth & Interfaces](./identity-auth-and-interfaces.md) | Identity/user/person/participant, Telegram login, access passes, API, Studio        |
| [Product Definition](./product/product.md)                       | Product vision, non-negotiable principles, what the product is/is not (normative)   |
| [Warmth Guidelines](./product/warmth.md)                         | Product voice formula and examples (normative)                                      |
| [Cultural Adaptation](./product/culture.md)                      | Cultural and language adaptation guidance (normative)                               |

## The 30-second model

```
Telegram group chat ──► chatbots app ──► conversation_events ──► processing_queue
                                                                       │ (ordered, per-family)
                       Router → Admin | Historian | (Scribe → ImageLink → Registrar)
                                                                       │
                                    claims + entities + stories (Postgres / Supabase, RLS)
                                                                       │
                                            Facilitator asks the next warm question

Studio (Solid.js) ──► api app (Elysia) ──► same Postgres  (view family, claim identity, admin)
        │
        └── super-admin WhatsApp import ──► import_jobs ──► conversation_events ──► processing_queue
```

Everything is **family-scoped** (`family_id` is the isolation boundary), every fact is a **sourced,
immutable claim**, and **conflicting memories are preserved**, never auto-resolved.
