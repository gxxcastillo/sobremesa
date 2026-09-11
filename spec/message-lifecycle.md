# Message Lifecycle

This document traces events from Telegram/import ingestion through queue processing and outbound
messages. Agent behavior is summarized in [`agent-pipeline.md`](./agent-pipeline.md).

## 4.1 Inbound Events

Telegram runs through one Telegraf `BotManager` in long-polling mode.

- `/sobremesa` in an allow-listed group, from a Telegram admin, registers the family or runs admin
  subcommands: pause/resume/status/help/language/studio-link.
- Private `/sobremesa` shows help.
- Text, photo, document, and member events are ingested only for active, unpaused families.
- Member joins/leaves are debounced; Telegram admin status is cached for registration and access-pass
  role assignment.

For each accepted inbound event, `MessageIngester`:

1. Ensures a global actor identity and pending family access.
2. Deduplicates by provider conversation/external event id.
3. Writes immutable `conversation_events`.
4. Enqueues `processing_queue` and logs ingestion.

## 4.2 Queue Processing

`MessageQueue` polls ready rows from `processing_queue`, leases one item, invokes
`MessageProcessor`, and marks the row `done` or `error`. The database dequeue function computes, for
each family, a single next candidate — its stale `processing` row if one exists, else its oldest
ready `queued` row when it has no live in-flight row — orders these per-family candidates by
priority then queued time, and leases the first one it can lock. A transaction-scoped advisory lock
per family plus a fresh-statement recheck of the family's in-flight state (not just the
candidate-selection query's own snapshot) close the window between candidate selection and lease, so
two workers can never hold two in-flight rows for the same family. A family's own stale row is
always retried before its newer queued rows, rather than waiting for every other family's queue to
drain. The live processor handles one item at a time per worker; the dequeue exclusion preserves
deterministic per-family text order across workers.

Every `processing_queue` row also carries an `intent` (`'live' | 'import'`, default `'live'`), and
the dequeue function takes an optional intent filter. The always-on live poller (`apps/chatbots`)
restricts itself to `['live']` — it can never claim an `'import'`-owned row, which exists
specifically so the import drain (§4.6) and the live poller never compete for the same row: import
deliberately never wires `admin`/`historian`/`facilitatorNudge`, so a historical message must never
be processed by the live pipeline instead.

`MessageProcessor`:

1. Loads the event and shared recent context.
2. Marks answered bot questions when the event replies to a tracked question and carries that
   question text forward as extraction context.
3. Creates image records for media.
4. Routes to ignore, admin, historian, or Scribe, and logs exactly one `intern_evaluated` audit
   event per `InternAgent.route()` call — the canonical, append-only record of that routing
   decision (action, relevance, reason, language, and whether it was deterministic or model-backed),
   for every ingress alike. It is derived processing history, not a later pipeline input.
5. Runs the Scribe path when appropriate: filter → Scribe → image-link fallback → Registrar.
6. Returns a success/failure result. `MessageProcessor` never marks the queue row itself; the queue
   loop is the sole owner of completing or failing it. Failures requeue for retry up to a max
   attempt count, then dead-letter (`status = 'error'`). A retried (non-dead-lettered) item's
   `process_after` is pushed out by `retryDelayMs` so retries are spaced out rather than firing on
   the very next poll.

Historian-routed messages fall through to Scribe once Historian's own answer succeeds, so user
questions can contribute facts. A Historian failure is reported as a processing failure immediately,
before Scribe runs, so the queue retries answering the question rather than re-running Scribe's
persist path on every failed attempt: Registrar's story-append is not yet idempotent on retry (a
retried Scribe pass can duplicate story content), so a message is only ever run through Scribe once
per Historian success; the message still reaches Scribe once Historian succeeds, including on a
later retry.

Dead-lettered items are visible and recoverable per family via the API (§6.3 of
[`identity-auth-and-interfaces.md`](./identity-auth-and-interfaces.md)): list errored items, or requeue
one back to `queued` (resets attempts) for retry.

## 4.3 Outbound Messages

`BotManager.sendMessage()` maintains an in-memory priority queue per chat, serializes sends, spaces
messages to avoid flooding, and returns the Telegram message id. Facilitator stores that id on asked
questions so replies can be matched as answers.

## 4.4 Questions

Questions move through:

```
proposed → asked → answered
     └──── retired
```

Facilitator asks the highest-priority eligible question, records the external message id, and logs
`question_asked`. A reply to that message marks the question `answered`, logs `question_answered`,
adds the original question as an explicit Scribe context block, and then flows through normal
extraction. Intern's deterministic filter (§3.2 of [`agent-pipeline.md`](./agent-pipeline.md))
normally discards an empty, too-short, or emoji-only message without ever calling Scribe or the LLM
filter. A non-empty reply to a tracked question bypasses filtering entirely: it may be a bare "no",
a thumbs-up emoji, or a fuller confirmation, and the explicit question block gives Scribe the context
to extract it safely. A truly empty body is still discarded. Word-based judgments — is this an
acknowledgement, a continuation of the previous message — are not hardcoded by word list (that
doesn't scale across languages); outside tracked answers they fall through to the filter LLM, which
already gets the recent conversation for context.

## 4.5 Family Activation

A family is created by `/sobremesa` registration in an allow-listed chat by a Telegram admin.
Ingestion accepts messages only when the family is active and not paused. Chat commands can pause,
resume, show status/help, set primary language, and create Studio links.

## 4.6 Imported History

There is no pre-extraction review checkpoint: every ingress — Studio import, CLI import, and live
chat — persists an event, queues it, and runs the same shared Intern → Scribe → Registrar pipeline
immediately. A prior design paused every Studio import at a two-phase human review step backed by a
mutable `intern_decisions` table; that was retired (see ADR-032 and
`.agents/plans/unified-import-pipeline-plan.md`) because Intern's per-message routing result is
derived processing history, not family knowledge or a workflow gate, and a held-open review pauses a
background pass indefinitely on browser/device/server availability. Quality control after import
happens through the existing claim/admin/redaction paths, on durable data, not by approving raw
messages one at a time before extraction.

The Studio WhatsApp import path enters through the API but reuses the same ledger and queue:

1. Browser parses/previews a `.txt` export and posts file + family/participant config.
2. `ImportProcessor` creates/reuses family and participant records, then inserts immutable
   `conversation_events` under an import conversation id. Every parsed event is written unconditionally
   — there is no pre-queue skip/process decision at this stage (matches live's `MessageIngester`,
   which never consults Intern before enqueueing either).
3. Once events are inserted, the API automatically runs the shared **import drain**
   (`runImportDrain()`, `libs/import/src/lib/import-drain.ts`): every event in the job's conversation
   is enqueued with `intent: 'import'` and drained directly (by event id, not via the shared dequeue
   function, so this never competes with the live poller) through `buildMessagePipeline({ stages:
['router', 'filter', 'imageLinker', 'scribe', 'registrar'] })` — the same real
   Intern → Scribe → Registrar pipeline a live message gets, minus `admin`/`historian`/
   `facilitatorNudge`: a historical import must never send an outbound message or answer a question.
4. The import job's status moves straight from inserting messages to `complete` (or `failed`) once
   the drain finishes — no manual API call and no intermediate review state.

`sbm import`/`sbm process` (local dev CLI) enqueue every parsed event unconditionally (default
`intent: 'live'`, since nothing else competes with a local one-shot batch run) and drain them through
`sbm process`'s own default stage set (`router, filter, imageLinker, scribe, registrar`) — the same
per-event shape a live message gets, just run as a batch; `sbm process` accepts an optional `--intent`
filter (`live` or `import`) for scoping a run to one owner.

Every actual `InternAgent.route()` resolution, on any ingress, writes exactly one `intern_evaluated`
audit event (§4.2) — the durable record of what Intern decided and why. It is never read back as
pipeline input.

Duplicate checking compares timestamp, actor, and content prefix before import. Failed imports can be
resumed (re-entering insertion, then the drain, automatically); in-progress imports can be cancelled
between insertion batches.
