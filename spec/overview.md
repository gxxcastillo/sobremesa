# System Overview

## 1.1 What Sobremesa is

Sobremesa is an **AI-powered family-history collection system**. A Telegram bot is added to a
family's existing group chat; it quietly observes the conversation, extracts structured genealogical
knowledge (people, places, events, relationships, stories), and occasionally asks a warm follow-up
question. Every stored fact is modelled as a sourced **claim**, so provenance is preserved and
conflicting memories are kept side-by-side rather than auto-resolved.

The product intent is warmth over efficiency, preservation over resolution, and conflicts honoured
rather than erased — see [`spec/product/product.md`](./product/product.md) for the normative
product definition.

## 1.2 Top-level behaviour

```
Telegram group chat
      │  (message / photo / join / leave / command)
      ▼
chatbots app  ──ingest──►  conversation_events  ──enqueue──►  processing_queue
                                                                   │
                                                  poll (ordered, per-family, sequential)
                                                                   ▼
                                              MessageProcessor pipeline
                          Router → (Admin | Historian | Scribe→ImageLink→Registrar)
                                                                   │
                                      writes claims/entities/stories to Postgres (Supabase)
                                                                   │
                          Facilitator asks the next pending question (fire-and-forget)

Studio (web) ── HTTPS ──► api app ──► same Postgres (read summaries, claim identity, admin)
      │
      └── WhatsApp import wizard ──► import_jobs + intern_decisions ──► queue selected messages
```

## 1.3 Repository Shape

The repo is a Bun workspace orchestrated by Nx and written in TypeScript. Exact tool and package
versions are controlled by [`../package.json`](../package.json), [`../bun.lock`](../bun.lock), and
project-level manifests.

### Deployable apps (`apps/`)

| App        | Runtime / framework                                      | Role                                                    | Deploy target                                       |
| ---------- | -------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------- |
| `chatbots` | Bun + **Telegraf 4** (long-polling)                      | The live bot + agent pipeline. No HTTP port.            | Fly.io (`sobremesa-chatbots`, process)              |
| `api`      | Bun + **Elysia** (`@elysiajs/swagger`, `@elysiajs/cors`) | REST API backing the Studio web app                     | Fly.io (`sobremesa-api`, HTTP :8080, scale-to-zero) |
| `studio`   | **Solid.js** + `@solidjs/router` + Vite                  | Web UI for viewing the family, claiming identity, admin | Vercel (static + `/api/*` proxy to the api app)     |
| `db`       | Supabase CLI                                             | Postgres schema + migrations                            | Supabase Cloud                                      |

### Libraries (`libs/`)

Key library groups:

- `agents/*`: Intern, Scribe, Registrar, Historian, Facilitator, Admin, Curator.
- `queue`, `ingester`, `telegram`: ingestion and processing.
- `database`, `auth`, `api-client`: persistence, access, and browser API client.
- `ai-provider`, `prompts`: LLM abstraction and prompt templates.
- `import`, `import-utils`: WhatsApp history import.
- `shared/*`: shared types and utilities.

See [`identity-auth-and-interfaces.md`](./identity-auth-and-interfaces.md) for API/Studio details and
[`ai-providers-and-prompts.md`](./ai-providers-and-prompts.md) for the LLM layer.

## 1.4 Technology stack

- **Runtime:** Bun (Node-compatible TypeScript).
- **Monorepo:** Nx, Bun workspaces (`apps/*`, `libs/*`, `libs/shared/*`, `libs/agents/*`).
- **Database:** PostgreSQL via **Supabase**. Schema migrations live in
  `apps/db/supabase/migrations/`; Row-Level Security is enabled and immutability is enforced by
  triggers.
- **LLM:** Anthropic Claude (`@anthropic-ai/sdk`), with an OpenAI-compatible path for local models
  and a mock provider for tests.
- **Chat provider:** Telegram (Telegraf 4). The provider is abstracted behind the ingester/queue, but
  Telegram is the only implementation.
- **Validation:** Zod (+ `zod-to-json-schema` for structured-output schemas).
- **Logging:** Pino.

## 1.5 Configuration & environment variables

Each app reads its own environment; libraries do not read `process.env` directly. Required groups are:
Supabase, Telegram bot, access-pass JWT secret, optional AI provider settings, Studio URL/build vars,
logging, and production admin-login secret. `.env.example` is the complete list.

## 1.6 Per-family configuration

Runtime behaviour is configured **per family**, primarily via a JSONB `config` carried with the
family record (languages, bot display names, personality levers, cultural terms). A separate
`family_config` table stores optional JSONB config snapshots. Agent personas and tone are therefore
not hard-coded — prompts contain placeholders (`{SCRIBE_NAME}`, `{FACILITATOR_NAME}`,
`{CULTURAL_TERMS}`, `{FORMALITY}`, …) filled from family config at runtime. The Historian's default
name is `Clio` (`libs/agents/historian/src/lib/types.ts`).

## 1.7 Cross-cutting invariants

1. **Family isolation.** `family_id` is the primary isolation boundary; reads, writes, and
   deduplication stay within a family.
2. **Immutable provenance.** Raw events and claims are append-only. Mutable processing, analysis,
   redaction, and status live separately.
3. **Single writer.** Only the Registrar writes core entity/claim tables from the pipeline.
4. **Conflicts are data.** Contradictory claims are linked, never deleted or auto-merged.
5. **Ordered, sequential processing per family.** The queue processes one event at a time in order so
   that pronoun/context resolution is deterministic. The database dequeue function enforces this
   structurally: per-family exclusivity uses a transaction-scoped advisory lock plus a
   fresh-statement recheck of in-flight state (not just the candidate-selection snapshot), so
   concurrent workers can never hold two in-flight rows for the same family, and a family's own
   stale row is always retried before its newer queued rows rather than waiting for every other
   family's queue to drain. Telegram long-polling and the in-memory outbound send queue remain
   deliberate single-instance constraints outside this processing invariant.
6. **Entity resolution favors precision.** False merges are worse than duplicates; matching must be
   structurally anchored and high-confidence.
