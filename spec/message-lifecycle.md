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

Every `processing_queue` row also carries an `intent` (`'live' | 'triage' | 'extract'`, default
`'live'`), and the dequeue function takes an optional intent filter. The always-on live poller
(`apps/chatbots`) restricts itself to `['live', 'extract']` — it can never claim a `'triage'`-intent
row, which exists specifically so a scoped import drain (§4.6) and the live poller never compete for
the same row.

`MessageProcessor`:

1. Loads the event and shared recent context.
2. Marks answered bot questions when the event replies to a tracked question and carries that
   question text forward as extraction context.
3. Creates image records for media.
4. Routes to ignore, admin, historian, or Scribe.
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
filter; when the message is a reply to a tracked question, that discard is skipped instead (except
for a truly empty body), since a bare "no" or a thumbs-up emoji is exactly how a real answer to a
yes/no question looks. Word-based judgments — is this an acknowledgement, a continuation of the
previous message — are not hardcoded by word list (that doesn't scale across languages); they always
fall through to the filter LLM, which already gets the recent conversation for context.

## 4.5 Family Activation

A family is created by `/sobremesa` registration in an allow-listed chat by a Telegram admin.
Ingestion accepts messages only when the family is active and not paused. Chat commands can pause,
resume, show status/help, set primary language, and create Studio links.

## 4.6 Imported History

The Studio WhatsApp import path enters through the API but reuses the same ledger and queue:

1. Browser parses/previews a `.txt` export and posts file + family/participant config.
2. `ImportProcessor` creates/reuses family and participant records, then inserts immutable
   `conversation_events` under an import conversation id. Every parsed event is written and, later,
   enqueued unconditionally — there is no separate pre-queue skip/process decision at this stage
   (matches live's `MessageIngester`, which never consults Intern before enqueueing either).
3. **Phase 1 (triage).** Every event in the job's conversation is enqueued with
   `intent: 'triage'` and drained directly (by event id, not via the shared dequeue function, so
   this never competes with the live poller or a concurrent scoped drain) through
   `buildMessagePipeline({ stages: ['router', 'filter'] })` — Intern's real router and filter, the
   same free-rule-then-LLM-fallback judgment a live message gets, at no Scribe cost. Every verdict
   (relevant or not) is recorded into `intern_decisions` via a filter-decision callback threaded
   through `MessageProcessor`, replacing the old free heuristic-only guess.
4. **Human review**, unchanged UI/UX: the Studio wizard shows each message with Intern's real
   `process`/`skip` decision and reason; a super admin can override any of them.
5. **Phase 2 (extraction).** The human-approved (`process`) events are re-enqueued with
   `intent: 'extract'` and drained through `buildMessagePipeline({ stages: ['scribe', 'registrar'] })`
   — `'filter'` is deliberately excluded here: `MessageProcessor` defaults `shouldProcess` to `true`
   when no filter is wired, and re-running it would both double-pay for the same judgment and risk
   silently overriding a human's override.

`sbm import`/`sbm process` (local dev CLI) don't have a human reviewer in the loop, so they collapse
phases 1-2 into `sbm process`'s own single default pass (`router, filter, imageLinker, scribe,
registrar`) — the same per-event shape a live message gets, just run as a batch. `sbm import` enqueues
every parsed event unconditionally (default `intent: 'live'`, since nothing else competes with a
local one-shot batch run); `sbm process` accepts an optional `--intent` filter for replicating the
Studio two-phase shape locally if needed.

Duplicate checking compares timestamp, actor, and content prefix before import. Failed imports can be
resumed; in-progress imports can be cancelled between insertion batches.
