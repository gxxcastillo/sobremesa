# Data Model

Ground truth is the Supabase migration in `apps/db/supabase/migrations/` and the domain types in
`libs/shared/types/src/lib/*`. This file captures the shape and invariants, not every column.

## 2.1 Core Model: Claims Over Facts

Sobremesa stores family knowledge as **claims**: sourced, immutable statements about entities. Entities
such as people, places, events, and stories are the things claims refer to; they are not treated as
unsourced fact containers.

```
conversation_events ──Scribe──► extracted claims ──Registrar──► claims
                                                               ├── claim_analysis
                                                               ├── claim_entities
                                                               ├── claim_relationships
                                                               └── claim_conflicts
```

Key rules:

- `conversation_events` and `claims` are append-only. Mutable state lives in separate processing,
  analysis, redaction, or status fields/tables.
- Claims preserve who said what, when, from which source message, with confidence and certainty
  language.
- Attribution is pipeline-stamped, never LLM-inferred: `claimed_by` and `claimed_by_identity_id` are
  set by the Registrar from the source event's deterministic sender, not from extracted text.
  `attributed_to` carries secondhand attribution the speaker themselves asserted (e.g. "Mom always
  said...") as free text — separate from, and never a substitute for, the deterministic sender.
- Conflicts are represented as links between claims; they are not erased by choosing a single truth.
- Claim strength is recomputable in `claim_analysis`, so scoring can evolve without rewriting the
  claim.

## 2.2 Entities and Relationships

Primary entity tables are `people`, `places`, `events`, and `stories`. They are family-scoped,
soft-redactable, and merge-aware.

- **People** may be placeholders (`isPlaceholder`) such as "Ralph's sister" until an identity claim
  resolves them. Whether a name is a placeholder, and which kind, is decided by
  `classifyPersonName` (`libs/shared/utils`): `relational` names describe someone by their
  relationship to another named person ("Ralph's sister", "la tía de Juan") and may only be matched
  or reused by exact normalized name; `generic` names are plain generic references ("someone", "the
  neighbor") or speaker-relative terms ("mi papá") and are never reused across mentions.
- **Places**, **events**, **relationships**, and image references use controlled vocabularies enforced
  at the extraction/type layer rather than as DB enum/check constraints.
- Join tables connect stories/events to people, places, source messages, and each other.
- **Stories** grow by appending. `story_conversation_events` records which messages contributed;
  a message contributes at most once, and its story text and source link are written together by
  the `persist_story_contribution` database function (see §3.4 of
  [`agent-pipeline.md`](./agent-pipeline.md)).

Relationships are intentionally minimal:

- **Stored structural:** `parent`, `spouse`.
- **Stored extended:** `guardian`, `godparent`, `mentor`, `friend`, `caregiver`.
- **Derived:** sibling, grandparent, aunt/uncle, cousin, and similar graph relationships.

## 2.3 Entity Merges

`entity_merges` records source entity → target entity, strategy, confidence, actor, and reason.
Merges mark source entities as superseded but do not destroy claims. This makes undo and provenance
possible. Merge logic must favor precision over recall: a duplicate entity is recoverable; a false
merge corrupts memory.

## 2.4 Ingestion, Queues, and Imports

`conversation_events` is the immutable message ledger. It stores provider, conversation id, external
event id, actor, event type, original content, language, metadata, timestamps, and per-family sequence.

Supporting ingestion tables:

- `conversation_event_processing`: rerunnable preprocessing/interpretation metadata.
- `conversation_redactions`: privacy redactions without mutating the raw event.
- `ingestion_batches`: batch/import provenance.
- `sequence_counters`: deterministic per-family event ordering.

Queues:

- `processing_queue`: ordered retryable event pipeline, with priority, leases, attempts, and
  stale-lock recovery. Items that exhaust retries dead-letter (`status = 'error'`); admins can list and
  requeue dead-lettered items per family. `intent` (`'live' | 'import'`, default `'live'`) marks what
  a row is queued _for_; the dequeue function takes an optional intent filter so the always-on live
  poller (`['live']`) never claims an `'import'`-owned row (§4.6 of
  [`message-lifecycle.md`](./message-lifecycle.md)) — import deliberately never wires
  `admin`/`historian`/`facilitatorNudge`, so a historical message must never be processed by the live
  pipeline instead. Admin's consolidated join welcome sends one welcome for every still-queued join in
  the conversation. Before sending, it marks the other joins' rows `done` without running them. In the
  same update, it records the triggering join event in `consolidated_into_event_id`. Every later
  attempt of that trigger re-gathers those rows, following the links transitively. Examples are a
  queue retry after a failed send, a stale-lock re-lease, or an operator requeue. Each member keeps
  their place in the welcome and in onboarding.
- `llm_evaluation_queue`: async review queue for uncertain claim strength, entity matches, or
  conflict resolution. Claims can be enqueued today; no live worker drains it.

Imports:

- `import_jobs`: super-admin import jobs. `source` names the export format (`whatsapp`, `telegram`,
  or `other`). Both job-creating entry points (`sbm import`, `POST /api/imports`) resolve it via
  the shared `resolveImportSource` (explicit or auto-detected from the file), and the background
  processor (`ImportProcessor`) parses using the same `IMPORT_PARSERS` registry (`libs/import-utils`)
  keyed by the job's stored `source`. WhatsApp is the only source with a parser implemented today --
  the others are reserved and fail clearly rather than being mis-parsed as WhatsApp (Studio's wizard
  is WhatsApp-only and always sends `source: 'whatsapp'` explicitly). The implemented path parses
  the export, creates/reuses family and participant records, inserts immutable `conversation_events`,
  then automatically runs the shared import drain through to `complete`/`failed` — no pre-extraction
  review checkpoint and no separate decision table (§4.6 of
  [`message-lifecycle.md`](./message-lifecycle.md)). Intern's per-event routing result for an import,
  like every other ingress, is recorded only as an `intern_evaluated` `event_log` entry (§2.5) — never
  a mutable per-import table.

## 2.5 Media, Questions, Audit, and Integrity

- `images`: media catalog and optional Curator analysis fields. The live app records media but does
  not attach Curator analysis.
- `questions`: Facilitator question lifecycle: `proposed → asked → answered`, with `retired` as an
  exit state. `origin IN ('curator', 'human', 'followup')`. `expires_at` is nullable; a `proposed`
  question past its `expires_at` is excluded from `findPending` and is retired rather than asked
  (Phase A story follow-ups use this; other origins leave it null, with no expiry).
- `outbound_messages`: durable send ledger for the outbound Telegram path -- claim-before-send,
  confirm-after dedup keyed on `(family_id, dedup_key)`, `status IN ('pending','sent','failed',
'unknown')`. `conversation_event_id` (reactive: Historian answers, admin replies) and `question_id`
  (proactive: Facilitator questions) are both nullable, family-scoped composite FKs recording what a
  send is about. Deleting either referenced row retains the ledger row and clears only that nullable
  provenance ID, never its non-null `family_id`. Backend-only (no RLS; explicitly revoked from `anon`/`authenticated`, like
  `allowed_chats`) -- no decided Studio read surface yet. Every pipeline send (Historian answers,
  Facilitator questions, admin replies, join welcomes, onboarding messages) claims a row through
  `BotManager`; see §4.3 of `message-lifecycle.md`.
- `event_log`: audit trail for ingestion, filtering/routing, redaction, questions, conflicts, imports,
  and errors. `intern_evaluated` is the canonical, append-only record of every `InternAgent.route()`
  resolution (action, relevance, reason, language, deterministic-vs-model provenance), written exactly
  once per call for every ingress (live chat, Studio import, CLI import) alike. It is derived
  processing history, never read back as pipeline input, and is the only durable record of Intern's
  per-message decision -- there is no separate decision table.
  `entity_enriched` records each Registrar write that changes fields on an existing person, event or
  story (source message, entity id, changed field names, whether the extraction was marked
  `from_context`) — the only provenance for enrichments, which have no backing claim.
  `followup_evaluated` likewise records each story follow-up run that proposed nothing, as an
  `outcome` category with no reason text (§4.7 of `message-lifecycle.md`).
- `integrity_checkpoints`: schema support for tamper-evident checkpoints; no application code writes
  them today.

Coaching tables (`facilitator_rules`, `real_time_levers`, `facilitator_performance`) exist in the
schema but are not used by the live app.

## 2.6 Isolation and Privacy

Family isolation is enforced by application repositories, which require `familyId` on family-scoped
operations and filter by `family_id`. Database RLS policies and helper functions exist on these
tables too, but `apps/api` and `apps/chatbots` both construct their `DatabaseClient` with the
Supabase **service-role** key (`createDatabaseClient`, `libs/database/src/lib/client.ts`), which
bypasses RLS entirely — RLS never evaluates for any current caller. RLS is defense-in-depth for a
future non-service-role access path (e.g. a client using the anon key directly), not a second active
layer today; see [`identity-auth-and-interfaces.md`](./identity-auth-and-interfaces.md) §6.2. The
privilege-verification invariant below still matters regardless: it keeps every table's RLS/GRANT
configuration correct for the day a non-service-role path exists, and GRANTs alone (independent of
RLS) already gate what the anon/authenticated keys can touch if ever used directly.

`identities` and `users` are global. Per-family membership and permissions live in `family_access`.
Raw `conversation_events` are service-role only; browser access goes through backend endpoints and
derived summaries.

Postgres checks table-level GRANTs independently of and before RLS policies. Every table must land in
one of two states: RLS enabled with SELECT/INSERT/UPDATE/DELETE granted to `anon`/`authenticated`, or
explicitly `REVOKE`d from those roles as backend-only (e.g. `allowed_chats`). A table with RLS enabled
but no matching GRANT fails every client query with "permission denied" regardless of policy
correctness; a table with a GRANT but no RLS is fully exposed. A migration that adds a table must also
grant or revoke it explicitly — the bootstrap privilege sweep in the init migration only covers tables
that existed when it ran. `bun nx test db` (`apps/db/scripts/verify-table-privileges.ts`) checks this
invariant across all migration files.

Redaction is non-destructive:

- Entity redaction marks rows as redacted.
- Conversation redaction creates `conversation_redactions` records while preserving the raw event.
  Redacted events are left out of the conversation-event reads that feed agents, including
  recent-message context windows, reply-to lookups, import-drain enumeration and consolidated-join
  gathering. They are also left out of the admin reprocess endpoint. A redacted event that is still
  queued is skipped by `MessageProcessor` (§4.2 of [`message-lifecycle.md`](./message-lifecycle.md)).
  Ingestion dedup still sees a redacted event, so a redelivered message is not re-ingested.
  Redacting an event that was already processed does not retract what was extracted from it: its
  claims and the people, places and stories they support stay live. No app code creates
  conversation redactions yet.

## 2.7 Table Catalogue

The current migration defines 41 tables:

- Tenancy/config: `families`, `family_config`, `sequence_counters`
- Ingestion/queue: `ingestion_batches`, `conversation_events`, `conversation_event_processing`,
  `conversation_redactions`, `processing_queue`
- Identity/access: `users`, `identities`, `family_access`, `access_passes`, `chat_admins`,
  `allowed_chats`
- Imports: `import_jobs`
- Entities/joins: `people`, `places`, `events`, `stories`, event/story join tables
- Relationships: `relationships`
- Claims: `claims`, `claim_analysis`, `claim_conflicts`, `claim_entities`, `claim_relationships`,
  `entity_merges`
- Async/media/questions/outbound/coaching/audit: `llm_evaluation_queue`, `images`, `questions`,
  `outbound_messages`, `facilitator_rules`, `real_time_levers`, `facilitator_performance`,
  `event_log`, `integrity_checkpoints`
