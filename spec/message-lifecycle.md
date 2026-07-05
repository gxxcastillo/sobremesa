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
`MessageProcessor`, and marks the row `done` or `error`. The database dequeue function leases by
priority then enqueue time, skips queued candidates for any family that already has a
`status = 'processing'` row, and uses stale-lock recovery for abandoned processing rows. The live
processor handles one item at a time per worker; the dequeue exclusion preserves deterministic
per-family text order across workers.

`MessageProcessor`:

1. Loads the event and shared recent context.
2. Marks answered bot questions when the event replies to a tracked question and carries that
   question text forward as extraction context.
3. Creates image records for media.
4. Routes to ignore, admin, historian, or Scribe.
5. Runs the Scribe path when appropriate: filter → Scribe → image-link fallback → Registrar.
6. Returns a success/failure result. `MessageProcessor` never marks the queue row itself; the queue
   loop is the sole owner of completing or failing it. Failures requeue for retry up to a max
   attempt count, then dead-letter (`status = 'error'`).

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
extraction.

## 4.5 Family Activation

A family is created by `/sobremesa` registration in an allow-listed chat by a Telegram admin.
Ingestion accepts messages only when the family is active and not paused. Chat commands can pause,
resume, show status/help, set primary language, and create Studio links.

## 4.6 Imported History

The Studio WhatsApp import path enters through the API but reuses the same ledger and queue:

1. Browser parses/previews a `.txt` export and posts file + family/participant config.
2. `ImportProcessor` creates/reuses family and participant records, then inserts immutable
   `conversation_events` under an import conversation id.
3. Import pauses for Intern review (`process|skip`, with super-admin overrides).
4. Selected events are enqueued into `processing_queue` and processed by the normal Scribe/Registrar
   path.

Duplicate checking compares timestamp, actor, and content prefix before import. Failed imports can be
resumed; in-progress imports can be cancelled between insertion batches.
