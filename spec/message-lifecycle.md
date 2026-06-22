# Message Lifecycle

This document traces an event end-to-end: from a Telegram update, through ingestion and the queue,
into the agent pipeline, and back out as an outgoing message. The agents themselves are specified in
[`agent-pipeline.md`](./agent-pipeline.md).

## 4.1 Inbound: Telegram → database

`libs/telegram` runs a single Telegraf bot (`BotManager`) in long-polling mode and registers handlers
in `ChatbotHandler`:

| Update                               | Handler behaviour                                                                                                                                                                                                                                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/sobremesa` (group, admin)          | Bootstrap family registration or run admin subcommands: `pause`/`stop`, `resume`/`start`, `status`, `help`, `lang:{code}`, `studio-link`. Registration requires Telegram-admin status **and** chat allow-listing; it creates the family (`FamilyRepository.createWithChat`) and syncs chat admins. |
| `/sobremesa` (private)               | Show help.                                                                                                                                                                                                                                                                                         |
| text message                         | → `TextMessageInput` → ingest (only if the family is active and not paused).                                                                                                                                                                                                                       |
| photo                                | → `PhotoMessageInput` (largest photo variant).                                                                                                                                                                                                                                                     |
| document                             | → `DocumentMessageInput`.                                                                                                                                                                                                                                                                          |
| chat-member join/leave               | → `MemberEventInput` (debounced); also updates the admin cache.                                                                                                                                                                                                                                    |
| bot added/removed (`my_chat_member`) | → admin sync.                                                                                                                                                                                                                                                                                      |

Telegram admin status is cached per chat with a 5-minute TTL by `AdminSyncHandler` and used to decide
roles for registration and access passes.

### Ingestion (`libs/ingester`)

`MessageIngester` is provider-agnostic. For each inbound message it:

1. **Ensures a global identity** for the actor and upserts a `family_access` row with
   `status='pending'` (records the actor as a chat participant).
2. **Deduplicates** by `(familyId, source, conversationId, externalEventId)` — returns `null` for a
   replay.
3. **Creates a `conversation_events` row** (immutable): actor info, `eventType`, `contentOriginal`,
   auto-detected `languageOriginal` (`detectLanguage()`), metadata, `occurredAt`/`ingestedAt`, and a
   sequence number.
4. **Enqueues** the event into `processing_queue` and writes an `event_ingested` entry to `event_log`.
   Member events are enqueued with a debounce delay (~5 s) to coalesce rapid join/leave churn.

## 4.2 The queue (`libs/queue`)

`MessageQueue` is a database-backed poller (one logical worker per instance, identified by
`workerId`):

- `enqueue(familyId, eventId, options)` writes a `processing_queue` row.
- `start()` runs a poll loop (`poll()` → `processOne()`); after a successful item it polls again
  immediately, otherwise it waits `pollIntervalMs` (default 1000 ms).
- `processOne()` dequeues the next ready item (respecting `processAfter`, priority, FIFO within
  priority), acquires a pessimistic lock, invokes the registered `MessageHandler`, and marks the row
  `done`/`error`. Stale locks (>5 min) are reclaimable.

The handler is `MessageProcessor.createHandler()`, which runs the pipeline in
[`agent-pipeline.md` §3.1](./agent-pipeline.md#31-orchestration-order).

Because items are processed one at a time in `(priority, queuedAt)` order, per-family text processing
is **ordered and sequential** — the property the Scribe relies on for pronoun/context resolution.

## 4.3 Processing a single event

`MessageProcessor.process(eventId, familyId)`:

1. Load the event; fetch the shared `MessageContext` (recent messages, recent images) once.
2. **Answer detection** — if the event is a reply to a tracked bot question, mark that question
   `answered` and log `question_responded`.
3. **Media** — for `photo|document|video`, create an `Image` record (file metadata) and fire the
   `onImageCreated` callback. The running app does not attach a Curator callback.
4. **Route** (if a Router is configured): `ignore | admin | scribe | historian`, logging the routing
   decision.
5. **Text content** (`processTextContent`): optional Filter → Scribe (extract domain model, store
   `interpretation` metadata) → ImageLinker (augment) → Registrar (persist).
6. Mark the event complete; return `{ success, duration }`.

Failures bubble up as `{ success:false, error }`; the queue records the error and increments
`attempts` for retry.

## 4.4 Outbound: database → Telegram

Outgoing messages go through `BotManager.sendMessage(role, message, options)`, which maintains an
**in-memory priority queue per chat**:

- Lower priority number sends first — user-triggered replies (≈2) beat bot-initiated nudges (≈7).
- A configurable minimum spacing between messages to the same chat (default ~3 s) prevents the bot
  from flooding a thread.
- Concurrent processing per chat is serialised; each send records a timestamp for spacing.
- `sendMessage` returns the Telegram `message_id`, which the Facilitator stores on the question so a
  later reply can be matched back to it (closing the answer-detection loop in §4.3).

## 4.5 Question lifecycle

Questions (the `questions` table) move through:

```
proposed ──Facilitator picks highest priority──► asked ──user replies (answer detection)──► answered
   │                                                                                          │
   └────────────────────────────── retired (no longer relevant) ◄────────────────────────────┘
```

- **proposed** — created as follow-ups worth asking (priority-ordered).
- **asked** — Facilitator sent it (warmth-formatted, addressed to a participant or the group) and
  recorded the external message id; logs `question_asked`.
- **answered** — a reply pointing at that message id was detected in §4.3; logs `question_responded`,
  and the answer itself flows back through the normal Scribe→Registrar extraction path.
- **retired** — dropped when superseded or stale.

## 4.6 Family activation & pausing

A family is created on `/sobremesa` registration in an allow-listed chat by a Telegram admin. Ingestion
checks that the family is **active and not paused** before accepting messages; `/sobremesa pause|stop`
flips a `paused` flag in family config and `/sobremesa resume|start` clears it. `lang:{code}` sets the
family's primary language. This is the only runtime control surface inside the chat.
