# Data Model

Ground truth is `apps/db/supabase/migrations/20260112074715_init_schema.sql` (38 tables) and the
TypeScript domain types in `libs/shared/types/src/lib/*`. Each table is reached from code through a
repository in `libs/database/src/lib/repositories/*` that maps `snake_case` columns to `camelCase`
domain objects.

## 2.1 The claims-based architecture

Sobremesa does **not** store facts directly on entities. It stores **claims** — atomic, sourced,
immutable statements — and treats entities (`people`, `places`, etc.) as the things claims are _about_.
This gives provenance, conflict tracking, and an audit trail for free.

```
conversation_event  (immutable raw message)
        │  Scribe extracts
        ▼
   ExtractedClaim ──Registrar──►  claims (immutable: who said what, when, how sure)
                                     │
                          ┌──────────┼───────────────┬─────────────────┐
                          ▼          ▼                ▼                 ▼
                   claim_analysis  claim_entities  claim_relationships  claim_conflicts
                   (mutable score) (links to       (supports/refines/   (disputes between
                                    people/places/  contradicts other    claims)
                                    events/stories)  claims)
```

### `claims` — immutable provenance (`claim-repository.ts`, `entities.ts`)

| Field                 | Meaning                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `claimType`           | one of `date` · `location` · `relationship` · `detail` · `identity` (validated by Registrar) |
| `subject`             | what the claim is about, with context (e.g. `"Maria's birth"`, `"Marcus's oldest son"`)      |
| `claimValue`          | JSONB — string or structured (`{"year":1992,"month":3,"day":13,"text":"March 13, 1992"}`)    |
| `conversationEventId` | the source message                                                                           |
| `claimedBy`           | name of the person who made the claim                                                        |
| `claimedBySource`     | `direct` · `attributed` · `hearsay`                                                          |
| `claimedAt`           | when it was claimed                                                                          |
| `confidence`          | extractor confidence: `high` · `medium` · `low`                                              |
| `certaintyLanguage`   | natural-language hedging captured verbatim ("maybe", "definitely", "creo que")               |
| `status`              | **the only mutable field:** `active` · `superseded` · `disputed` · `redacted`                |

Immutability is enforced in the database by the `enforce_claims_immutability` and
`prevent_claim_deletes` triggers — application code cannot rewrite or delete a claim, only transition
its `status`.

### `claim_analysis` — mutable, system-computed (`claim-analysis-repository.ts`)

Strength scoring is deliberately split out of the immutable claim into a 1:1 mutable record so it can
be recomputed:

- `claimStrength` (0.0–1.0), `inferenceMethod` (`direct` | `logical_inference` | `llm_inference`)
- `strengthFactors` — `{ algorithmScore, breakdown, llmScore?, llmReasoning?, final, evaluationTriggered[] }`
- `needsLlmEvaluation` — flag that enqueues the claim for async LLM review (see §2.6)

### Claim link tables

- **`claim_entities`** — many-to-many between a claim and the entities it touches. Fields: `entityType`
  (`person|place|event|story|relationship`), `role` (`subject`, `related`, `location`, `witness`,
  `identity_source`, `identity_target`), `resolved`, `entityMergeId`. Bidirectional, so "all claims
  about Maria" is a single query.
- **`claim_relationships`** — claim-to-claim edges: `supports`, `contradicts`, `refines`,
  `supersedes`, `derived_from`.
- **`claim_conflicts`** — recorded disputes between claims.

## 2.2 Entities

All four entity types are family-scoped, soft-deletable (`redacted`), and merge-aware (`supersededBy`,
`supersededAt`).

| Entity     | Table / repo                           | Key fields                                                                     |
| ---------- | -------------------------------------- | ------------------------------------------------------------------------------ |
| **Person** | `people` / `person-repository`         | `name`, `aliases[]`, `birthYear`, `deathYear`, `*Confidence`, `isPlaceholder`  |
| **Place**  | `places` / `place-repository`          | `name`, `type`, `city`, `region`, `country`                                    |
| **Event**  | `events` / `timeline-event-repository` | `title`, `eventType`, `dateText`, `dateYear`, `placeId`                        |
| **Story**  | `stories` / `story-repository`         | `contentOriginal`, `contentLanguage`, `themes[]`, `completeness`, `confidence` |

`isPlaceholder` marks descriptive (not-yet-resolved) people such as `"Ralph's sister"` or `"el vecino"`
that an identity claim may later merge into a named person.

Controlled-vocabulary fields (`Place.type`, `Event.eventType`, `Relationship.relationshipType`,
image `referenceType`) are constrained at the **Scribe extraction layer** (Zod enums) rather than by DB
`CHECK` constraints, so the vocabulary stays normalized — keeping merge/match heuristics that switch on
these values reliable — without coupling it to a migration.

- `Place.type`:
  `city|country|address|region|landmark|neighborhood|building`
- `Event.eventType`:
  `birth|death|marriage|immigration|migration|business|education|military|residence|travel|celebration|medical|work|other`
- `Relationship.relationshipType`:
  `parent|spouse|guardian|godparent|mentor|friend|caregiver`
- Image `referenceType`:
  `describes|identifies_people|provides_context|asks_about`

**Join tables** connect entities and provenance: `event_people`, `event_places`, `story_people`,
`story_places`, `story_events`, and `story_conversation_events` (which messages a story was drawn
from).

### Materialised fields from claims

`ClaimAggregatorService` (`libs/database/src/lib/services/claim-aggregator.ts`) rolls multiple claims
about the same entity field into a single materialised value:

- **Consensus** (>70 % weighted agreement) → `high` confidence
- **Close values** (e.g. birth years within 2) → weighted average, `medium`
- **Conflict** (>50 % but <70 %) → `medium`; otherwise `low`

It returns `{ value, confidence, supportingClaimIds, reasoning }` so the chosen value stays traceable.

## 2.3 Relationships (`relationships`, `relationships.ts`)

Relationships are split into three classes:

- **Structural (stored):** `parent` (A=parent, B=child) and `spouse` (UUID-ordered for symmetry) —
  the minimal backbone of the family tree.
- **Derived (computed, not stored):** sibling, grandparent, aunt/uncle, cousin, etc., obtained by
  graph traversal over the structural backbone (DB helper functions
  `get_participants_with_relationships`, `get_participants_related_to_subject`).
- **Extended (stored):** narrative relationships — `guardian`, `godparent`, `mentor`, `friend`,
  `caregiver`.

Each row carries `category` (`biological|legal|functional|honorary|social`), `status`
(`active|ended|deceased`), and an optional `qualifier` (`half|step|adoptive|maternal|paternal|estranged`).

## 2.4 Ingestion & conversation tables

| Table                           | Purpose                                                                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------- | ----- | ---- | ----- | ------------------------------------------------------------------------------------------------------------------------------- |
| `conversation_events`           | **Immutable** raw events from a chat provider: `source`, `conversationId`, `externalEventId`, `actorExternalId`, `eventType` (`message | photo | document | video | join | leave | edit`), `contentOriginal`, `languageOriginal`, `contentHmac`, `occurredAt`, sequence number. Update/delete blocked by triggers. |
| `conversation_event_processing` | **Mutable** preprocessing artifacts for an event: `detectedLanguage`, `imageReferences`, `processingMetadata`. Re-runnable.            |
| `conversation_redactions`       | Non-destructive redaction records (event stays intact); auto-logs to `event_log`; reversible.                                          |
| `ingestion_batches`             | Groups of ingested events.                                                                                                             |
| `sequence_counters`             | Atomic per-scope sequence assignment (deterministic event ordering).                                                                   |

## 2.5 Entity merges (`entity_merges`, `merge-handler` service)

Records that one entity was merged into another:
`sourceEntityId/Type → targetEntityId/Type`, `mergeStrategy`
(`fuzzy_match|identity_claim|manual|llm_resolved`), `confidence`, `mergedBy`
(`registrar|curator|admin|llm_resolver`), `mergeReason`.

- Merges are **deletable to undo** (the underlying claims preserve original provenance).
- Denormalised `supersededBy` columns on entity tables speed up "is this entity still current?".
- `get_entity_merge_chain()` (DB function) walks the merge history, so
  `findClaimsForEntityIncludingMerged()` returns claims about an entity _and_ all its merged
  predecessors.
- Circularity and dangling references are blocked by triggers (`prevent_circular_merges`,
  `validate_entity_merge_references`).

## 2.6 Queues

| Queue table            | Repo                              | Role                                                                                                           |
| ---------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `processing_queue`     | `processing-queue-repository`     | Ordered, retryable message pipeline. Fields: `processAfter` (debounce), `lockedAt/lockedBy`, `status` (`queued | processing   | done                                                                                                                                                                                      | error`), `attempts`, `priority`(1=critical…7=low). Dequeue uses pessimistic locking + 5-min stale-lock recovery, ordered by priority then`queuedAt`. |
| `llm_evaluation_queue` | `llm-evaluation-queue-repository` | Async LLM review of uncertain claims. Fields: `evaluationType` (`claim_strength                                | entity_match | conflict_resolution`), `entityType/entityId`, lease-based locking via `lockedUntil`, `result`JSONB. Batch-acquired with`acquireBatch()`. Claims are enqueued; no worker drains the queue. |

## 2.7 Media, questions, audit, integrity

- **`images`** — media catalog: file metadata plus Curator analysis fields (`description`,
  `peopleCount`, `estimatedEra`, `visibleText[]`, …).
- **`questions`** — follow-up question lifecycle (`proposed → asked → answered → retired`), priority,
  external message id (for reply detection). See [`message-lifecycle.md`](./message-lifecycle.md).
- **`event_log`** — complete audit trail. `eventType` covers ingestion, filtering, redaction, the
  question lifecycle, conflict detection, and errors; each entry has `eventCategory`, `actor`,
  `actorType`, `severity`, and optional `conversationEventId`/`identityId`.
- **`integrity_checkpoints`** — tamper-evident checkpoint hashes (Merkle/HMAC roots) with optional
  on-chain anchoring columns (`chain`, `tx_hash`). No application code writes checkpoint rows.

## 2.8 Coaching tables

`facilitator_rules`, `real_time_levers`, and `facilitator_performance` exist in the schema, but no
repository or application code references them. The Facilitator throttle is a simple time interval (see
`agent-pipeline`/`message-lifecycle`), not a dynamic lever system.

## 2.9 Multi-family isolation & Row-Level Security

Two layers enforce isolation:

1. **Application layer** — `BaseRepository` (`base-repository.ts`) puts `.eq('family_id', familyId)`
   on every read/write; all 30 repositories inherit it. `findById`, `findAll`, `insert`, `update`, and
   `softDelete` all require a `familyId`.
2. **Database layer** — Row-Level Security is enabled on the sensitive tables with ~105 policies, plus
   SQL helper functions (`get_identity_id`, `is_super_admin`, `get_user_family_ids`,
   `get_family_role`, `is_family_admin`, `has_family_access`, `is_family_member`). Views use
   `security_invoker=true` to respect RLS. `conversation_events` is intentionally **service-role only**
   (no client SELECT policy) so raw message content is never exposed to the browser.

`identities` and `users` are **global** (no `family_id`); per-family access is mediated by
`family_access` (see [`identity-auth-and-interfaces.md`](./identity-auth-and-interfaces.md)).

## 2.10 Redaction (privacy)

- **Entity-level:** `BaseRepository.softDelete()` sets `redacted`, `redactedAt`, `redactedBy`,
  `redactionReason` — entities stay for audit.
- **Conversation-level:** the raw event is immutable, so redaction is a separate
  `conversation_redactions` row with reason + actor, auto-logged to `event_log` and reversible via
  `unredact()`.

## 2.11 Table catalogue (38 tables, by domain)

- **Tenancy/config:** `families`, `family_config`, `sequence_counters`
- **Ingestion:** `ingestion_batches`, `conversation_events`, `conversation_event_processing`, `conversation_redactions`, `processing_queue`
- **Identity/access:** `users`, `identities`, `family_access`, `access_passes`, `chat_admins`, `allowed_chats`
- **Entities:** `people`, `places`, `events`, `stories`
- **Entity joins:** `event_people`, `event_places`, `story_people`, `story_places`, `story_events`, `story_conversation_events`
- **Relationships:** `relationships`
- **Claims:** `claims`, `claim_analysis`, `claim_conflicts`, `claim_entities`, `claim_relationships`, `entity_merges`
- **Async eval:** `llm_evaluation_queue`
- **Media:** `images`
- **Questions:** `questions`
- **Coaching [schema-only]:** `facilitator_rules`, `real_time_levers`, `facilitator_performance`
- **Audit/integrity:** `event_log`, `integrity_checkpoints`
