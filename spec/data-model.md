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
- Conflicts are represented as links between claims; they are not erased by choosing a single truth.
- Claim strength is recomputable in `claim_analysis`, so scoring can evolve without rewriting the
  claim.

## 2.2 Entities and Relationships

Primary entity tables are `people`, `places`, `events`, and `stories`. They are family-scoped,
soft-redactable, and merge-aware.

- **People** may be placeholders (`isPlaceholder`) such as "Ralph's sister" until an identity claim
  resolves them.
- **Places**, **events**, **relationships**, and image references use controlled vocabularies enforced
  at the extraction/type layer rather than as DB enum/check constraints.
- Join tables connect stories/events to people, places, source messages, and each other.

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
  requeue dead-lettered items per family.
- `llm_evaluation_queue`: async review queue for uncertain claim strength, entity matches, or
  conflict resolution. Claims can be enqueued today; no live worker drains it.

Imports:

- `import_jobs`: super-admin WhatsApp import jobs. The implemented path parses a `.txt` export,
  creates/reuses family and participant records, inserts immutable `conversation_events`, then pauses
  for review.
- `intern_decisions`: per-import-event `process|skip` decisions with optional user override. Selected
  messages are queued into the normal Scribe/Registrar path.

## 2.5 Media, Questions, Audit, and Integrity

- `images`: media catalog and optional Curator analysis fields. The live app records media but does
  not attach Curator analysis.
- `questions`: Facilitator question lifecycle: `proposed → asked → answered`, with `retired` as an
  exit state.
- `event_log`: audit trail for ingestion, filtering/routing, redaction, questions, conflicts, imports,
  and errors.
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

## 2.7 Table Catalogue

The current migration defines 41 tables:

- Tenancy/config: `families`, `family_config`, `sequence_counters`
- Ingestion/queue: `ingestion_batches`, `conversation_events`, `conversation_event_processing`,
  `conversation_redactions`, `processing_queue`
- Identity/access: `users`, `identities`, `family_access`, `access_passes`, `chat_admins`,
  `allowed_chats`
- Imports: `import_jobs`, `intern_decisions`
- Entities/joins: `people`, `places`, `events`, `stories`, event/story join tables
- Relationships: `relationships`
- Claims: `claims`, `claim_analysis`, `claim_conflicts`, `claim_entities`, `claim_relationships`,
  `entity_merges`
- Async/media/questions/coaching/audit: `llm_evaluation_queue`, `images`, `questions`,
  `facilitator_rules`, `real_time_levers`, `facilitator_performance`, `event_log`,
  `integrity_checkpoints`
