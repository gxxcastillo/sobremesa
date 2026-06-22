# System Overview

## 1.1 What Sobremesa is

Sobremesa is an **AI-powered family-history collection system**. A Telegram bot is added to a
family's existing group chat; it quietly observes the conversation, extracts structured genealogical
knowledge (people, places, events, relationships, stories), and occasionally asks a warm follow-up
question. Every stored fact is modelled as a sourced **claim**, so provenance is preserved and
conflicting memories are kept side-by-side rather than auto-resolved.

The product intent is warmth over efficiency, preservation over resolution, and conflicts honoured
rather than erased.

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
```

## 1.3 Repository shape (Nx monorepo)

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

| Library              | Responsibility                                                          |
| -------------------- | ----------------------------------------------------------------------- |
| `agents/scribe`      | Extract a structured domain model from message text                     |
| `agents/registrar`   | Persist the domain model: dedupe, entity-match, conflict-detect, score  |
| `agents/historian`   | Answer family-history questions from stored data                        |
| `agents/facilitator` | Ask warm follow-up questions; format/send Historian answers             |
| `agents/intern`      | Fast pre-processing: relevance filter, routing, image-reference linking |
| `agents/admin`       | Handle commands, DMs, member-join/leave, mentions                       |
| `agents/curator`     | Image vision analysis library; not attached to the live pipeline        |
| `ai-provider`        | LLM abstraction (Anthropic / OpenAI-compatible / mock)                  |
| `prompts`            | System-prompt `.txt` templates + loader                                 |
| `queue`              | `MessageQueue` (DB poller) + `MessageProcessor` (pipeline orchestrator) |
| `ingester`           | Provider-agnostic message → `conversation_events` ingestion             |
| `telegram`           | Telegraf bot manager, command handling, admin sync                      |
| `database`           | Supabase client, ~30 repositories, data-retrieval services              |
| `auth`               | Telegram-login verification, access passes, JWT session, Elysia guards  |
| `api-client`         | Browser client for the Studio app (`StudioApiClient`)                   |
| `shared/types`       | Domain types (claims, entities, relationships, queue, event-log…)       |
| `shared/utils`       | `Result<T,E>`, Pino logger, date/text helpers                           |

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

Each app reads its own environment (libraries do not read `process.env` directly — env access is kept
in the apps). See `.env.example` for the full list.

**Required (chatbots + api):** `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`TELEGRAM_BOT_TOKEN`, `ACCESS_PASS_SECRET` (JWT signing).

**LLM (optional — without them, agents run against the mock provider):**
`ANTHROPIC_API_KEY`, `AI_PROVIDER_DEFAULT` (`anthropic` | `local` | `mock`), per-agent overrides
`AI_PROVIDER_{INTERN|SCRIBE|HISTORIAN|FACILITATOR|CURATOR}`, and for local models
`LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODEL`, `LOCAL_LLM_API_KEY`.

**Other:** `STUDIO_URL` (access-pass link base), `LOG_LEVEL`, and for the Studio build
`VITE_TELEGRAM_BOT_NAME` / `VITE_API_URL`.

## 1.6 Per-family configuration

Runtime behaviour is configured **per family**, primarily via a JSONB `config` carried with the
family record (languages, bot display names, personality levers, cultural terms). A separate
`family_config` table stores optional JSONB config snapshots. Agent personas and tone are therefore
not hard-coded — prompts contain placeholders (`{SCRIBE_NAME}`, `{FACILITATOR_NAME}`,
`{CULTURAL_TERMS}`, `{FORMALITY}`, …) filled from family config at runtime. The Historian's default
name is `Clio` (`libs/agents/historian/src/lib/types.ts`).

## 1.7 Cross-cutting invariants

1. **Family isolation.** Every family-scoped row carries `family_id`; every repository query filters
   by it; deduplication happens only within a family. `family_id` is the primary isolation boundary.
2. **Immutability of source + provenance.** `conversation_events` and `claims` are append-only —
   enforced by Postgres triggers (`prevent_conversation_event_updates/deletes`,
   `enforce_claims_immutability`, `prevent_claim_deletes`). Edits happen via separate mutable tables
   (`conversation_event_processing`, `claim_analysis`) or status transitions.
3. **Single writer.** Only the Registrar writes core entity/claim tables from the pipeline.
4. **Conflicts are data.** Contradictory claims are linked, never deleted or auto-merged.
5. **Ordered, sequential processing per family.** The queue processes one event at a time in order so
   that pronoun/context resolution is deterministic.
6. **Entity resolution favors precision over recall.** Deduplication merges two extracted entities
   only on a high-confidence match. A **false merge** — collapsing two genuinely distinct
   people/events/stories/places — destroys a distinct memory and is strictly worse than a **missed
   merge**, which leaves a recoverable duplicate. This is the entity-level companion to invariant 4:
   just as contradictory _claims_ are never auto-merged, distinct _entities_ are not collapsed on weak
   similarity. Matching heuristics must be structurally anchored (word boundaries, date filters, people
   overlap) rather than relying on loose substring or score thresholds alone.
