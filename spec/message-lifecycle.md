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

Row ownership by intent is not, by itself, per-family exclusion: the import drain processes its rows
directly (§4.6) rather than leasing them through the dequeue function above, so without a separate
signal, the dequeue function's own family-level in-flight check would never see an import drain as
"in flight." The drain closes this by marking each row `'processing'` immediately before running it
(`ProcessingQueueRepository.markProcessing()`) — the same status the dequeue function's per-family
exclusion check already looks for — so a live-intent lease for that family is blocked for the
duration of that one event. This protection lapses if a single event takes longer than the dequeue
function's own lock-staleness window (`lockTimeoutMs`, default 5 minutes): a `'processing'` row older
than that is treated as abandoned and no longer blocks other leases. This matters when import targets
a family that also has live traffic (`existingFamilyId`, §4.6) — the default, no-existing-family case
has no live traffic to race against. `markProcessing()` is a CAS guard, not just bookkeeping: a caller
reprocessing a row left `'error'` by an earlier partial pass (e.g. a resumed import job) must pass
`'error'` among its expected statuses too, or the claim silently matches no row and that reprocessing
pass gets no in-flight protection at all. The local dev CLI's `sbm process --event-id` path claims a
row the same way before processing it directly, for the same reason.

`MessageProcessor`:

1. Loads the event. A redacted event (one with a `conversation_redactions` row) stops here: nothing
   runs for it, meaning no answer detection, routing, extraction or bot reply. It is logged as
   `event_processed` with status `skipped_redacted` and reported as success, so its row is marked
   `done`. The redaction check fails loud, so a lookup error retries the event rather than risk
   processing redacted content. Otherwise the processor loads the shared recent context.
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
persist path on every failed attempt: Registrar's persist is not fully idempotent on retry (story
contributions are, but a claim's analysis and links are not repaired; see §3.4 of
[`agent-pipeline.md`](./agent-pipeline.md)), so a message is only ever run through Scribe once per
Historian success; the message still reaches Scribe once Historian succeeds, including on a later
retry.

Dead-lettered items are visible and recoverable per family via the API (§6.3 of
[`identity-auth-and-interfaces.md`](./identity-auth-and-interfaces.md)): list errored items, or requeue
one back to `queued` (resets attempts) for retry.

## 4.3 Outbound Messages

`BotManager.sendMessage()` maintains an in-memory priority queue per chat, serializes sends, and
spaces messages to avoid flooding. It resolves with a `SendOutcome` rather than a bare message id:
`{ status: 'sent'; messageId }`, `{ status: 'duplicate'; messageId? }` (a prior claim on the same
dedup key already delivered -- not resent), or `{ status: 'unconfirmed' }` (an ambiguous outcome --
also not resent). It throws only `MessageDeliveryError` for a definitive, provably-not-delivered
failure. Facilitator stores the `sent`/`duplicate` message id on asked questions so replies can be
matched as answers.

Telegram's Bot API has no idempotency keys, so a send's outcome is classified, not made
deterministic: a `TelegramError` with a 4xx code (including 429) is provably not delivered and is
thrown as `MessageDeliveryError`; a 5xx or network/timeout error is irreducibly ambiguous and is
never thrown -- callers must not treat it as a failure requiring a retry-driven resend. This is the
outbound analog of precision-over-recall: **prefer a lost message over a duplicate.** A lost answer
is recoverable (the user asks again); a duplicate is not.

When a caller passes `options.dedup` (a family-scoped key plus optional `conversationEventId`/
`questionId` provenance), `sendMessage()` claims that key in the durable `outbound_messages` ledger
(`data-model.md` §2.5) _before_ attempting delivery and confirms the outcome after: a key whose prior
claim already reached `'sent'` short-circuits to `'duplicate'` with no second Telegram call; a key
whose prior claim is still `'pending'`/`'unknown'` (outcome not yet known) short-circuits to
`'unconfirmed'`, also with no call -- an unresolved outcome is never resent. This makes delivery
at-most-once per dedup key even across a crash-and-retry of the caller. Every pipeline send
passes a stable key: `historian-answer:<conversation_event_id>`, `facilitator:question:<question_id>`,
`admin:<subtype>:<conversation_event_id>` (status, dm, leave, mention), `admin:join:<triggering
event id>`, and `admin:onboarding[-reminder]:<identity_id>:<family_id>`. Only `ChatbotHandler`'s
direct `ctx.reply` command replies bypass the ledger; they are classified the same way but untracked.

Bot-authored text is deliberately never written to `conversation_events` -- the grounding check
(§3.4 of `agent-pipeline.md`) depends on bot text never being extractable, and this holds for both
the untracked send path and the ledger.

## 4.4 Questions

Questions move through:

```
proposed → asked → answered
     └──── retired
```

Facilitator asks the highest-priority eligible question, records the external message id, and logs
`question_asked`. A paused family (§4.5) is skipped before anything is sent or marked asked —
pausing intake without also pausing this outbound path would leave a family "paused" in appearance
only (#6a). A reply to that message marks the question `answered`, logs `question_answered`,
adds the original question as an explicit Scribe context block, and then flows through normal
extraction. Intern's deterministic filter (§3.2 of [`agent-pipeline.md`](./agent-pipeline.md))
normally discards an empty, too-short, or emoji-only message without ever calling Scribe or the LLM
filter. A non-empty reply to a tracked question bypasses filtering entirely: it may be a bare "no",
a thumbs-up emoji, or a fuller confirmation, and the explicit question block gives Scribe the context
to extract it safely. A truly empty body is still discarded. Word-based judgments — is this an
acknowledgement, a continuation of the previous message — are not hardcoded by word list (that
doesn't scale across languages); outside tracked answers they fall through to the filter LLM, which
already gets the recent conversation for context.

`origin: 'followup'` questions (§3.6 of [`agent-pipeline.md`](./agent-pipeline.md)) join the same
table and the same `proposed → asked → answered` states, with two differences from a Curator/human
question: they carry an `expires_at` (24 hours from proposal) and take the `proposed → retired`
branch on expiry rather than only on manual retirement, and only one such question may be
`proposed` or recently `asked` for a family at a time (`QuestionRepository.hasWaitingOrRecent`,
24-hour pacing) — a second candidate message is simply never formulated while that holds. Proposal
happens inline in the live pipeline (§3.6). Asking one goes through Facilitator's ordinary
`proposed → asked` path (§3.5), plus its own additional 30-minute chat-quiet gate, expiry
retirement, and a conservative-cancellation check (any conversation activity recorded after the
question was proposed retires it outright, logged `question_retired` with
`reason: 'superseded_by_activity'`, checked before the quiet gate so it applies even once the chat
has since gone quiet again) — a deliberately activity-only policy (ADR-007) rather than a
content-aware recheck of whether the question still fits; the retirement log is meant to be mined
later for how often this actually fires. It is sent verbatim rather than through the warmth formula
(`spec/product/warmth.md`,
ADR-033). Nothing requests the `storyFollowup` proposal stage in production yet, so none of this
runs live today regardless.

## 4.5 Family Activation

A family is created by `/sobremesa` registration in an allow-listed chat by a Telegram admin.
Ingestion accepts messages only when the family is active and not paused. Pause (`config.paused`,
`isFamilyPaused` in `shared-types`) also suppresses Facilitator's outbound question sends (§4.4) —
both the per-message nudge and a batch sweep, since both share `askNextQuestion` — so a paused
family receives nothing unprompted either. Chat commands can pause, resume, show status/help, set
primary language, and create Studio links. Pause, resume, and language changes write a single
`families.config` key atomically (`FamilyRepository.updateConfigPath` → the row-locking
`update_family_config_path` function), so concurrent changes to sibling keys cannot overwrite
each other.

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
   A single drain pass makes exactly one attempt per event and never revisits a `'queued'` row within
   that pass, so a per-event failure dead-letters immediately (`status = 'error'`, unlike the live
   queue's multi-attempt retry-then-dead-letter above) — it stays visible via the same
   errors/requeue surface rather than sitting as an unrecoverable `'queued'` row once the job
   completes.
4. The import job's status moves straight from inserting messages to `complete` (or `failed`) once
   the drain finishes — no manual API call and no intermediate review state. `complete` reflects the
   drain finishing its pass over every event, not that every event succeeded; per-event failures are
   dead-lettered (above), not retried by re-running the job.

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
between insertion batches and, during the drain, on the same throttled cadence as drain progress
reporting (every 10 events). The job's completion/failure write at the end of either phase is an
atomic transition guarded on the job still being in the expected in-progress status, so a cancel that
lands in the gap between checks is never silently overwritten back to `complete`/`failed`. The resume
API route is guarded the same way — an atomic transition from `failed` to `pending` — so two
overlapping resume calls (double-click, retry, a second admin) can't both pass the status read and
both start a second, concurrent `runImportJob` for the same job.

## 4.7 Operator Visibility and Recovery

Silence the system chose and silence caused by a failure are recorded and reported separately, so
"no question was asked" can always be told apart from "something broke."

**Alerts.** Every failure an operator must notice is logged at ERROR level through `logAlert()`
(`libs/shared/utils`), with an `alert` field naming its category. A notification sink can later select
alerts by that one field without changing call sites; today the log stream is the notification.

| `alert`                                                     | Raised when                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| `queue_dead_letter`                                         | A queue item exhausted its retries (`status = 'error'`)                  |
| `queue_poll_error`                                          | The queue poll loop itself threw                                         |
| `followup_provider_error` / `followup_unparseable_response` | Follow-up formulation failed (§3.6 of `agent-pipeline.md`)               |
| `followup_hook_error`                                       | The follow-up hook threw (e.g. a DB write failed)                        |
| `send_failed` / `send_unknown`                              | A Telegram send failed provably (4xx) / ambiguously (5xx, network)       |
| `send_unresolved_skip`                                      | A send was skipped because its dedup key's earlier outcome is unresolved |
| `bot_handler_error`                                         | A Telegram command handler threw, including a failed direct `ctx.reply`  |

Ordinary retries (an attempt that will be retried), follow-up declines, pacing skips, grounding
guards and question expiry are never alerts.

**Durable records.** Queue state lives in `processing_queue`; every pipeline send in
`outbound_messages` (§4.3); `ChatbotHandler`'s direct command replies are untracked, so their
failures surface only as `bot_handler_error` alerts. Each
story follow-up run that proposes nothing writes one `followup_evaluated` event with its `outcome`
(`suppressed_pacing`, `declined`, `no_text`, `empty_question`, `ungrounded_names`, `provider_error`,
`unparseable_response`) and severity `error` for the last two; no reason text, since the model's reason
can quote family content. A proposal logs `question_proposed`; expiry and activity-supersession log
`question_retired` with `reason`.

**Report.** `sbm status [--since=24h] [--family-id=…] [--json] [--allow-remote-db]`
(`PipelineHealthService` in `libs/database`) reports, per family, failures — every dead-lettered queue
row, `processing` rows locked past the 5-minute lease, the oldest due `queued` row once it has waited
over 15 minutes, `failed`/`unknown` sends in the window plus `pending` claims older than 10 minutes, and
follow-up failures — separately from chosen silence (follow-up outcome counts, retired questions) and
activity (proposed/asked). It exits 1 when any failure is reported. Spend usage and stop status are an
explicit "not implemented" slot until the LLM spend limit lands. The report is read-only.

**Review cadence (pilot).** Run the report at the end of every supervised session and once a day while
anything runs unattended, and note the result in the pilot observation log.

**Recovery.** Recovery never deletes or rewrites history, and never resends an ambiguous send.

- _Dead-lettered queue item:_ read `last_error`, fix the cause, then requeue it (`POST
/api/family/:familyId/queue/:itemId/requeue`, or `ProcessingQueueRepository.requeue`), which resets
  it to `queued` with a fresh `queued_at` -- it runs after anything already queued for that family. Registrar's persist is not fully idempotent on retry
  (§3.4 of `agent-pipeline.md`), so check whether a partial pass already wrote claims before
  requeueing.
- _Stale `processing` row:_ the next dequeue re-leases it after the lease timeout on its own; one that
  keeps reappearing is crashing or hanging its worker — read the bot logs for that event id.
- _Backlog:_ for `intent = 'live'`, the poller is not draining — check the bot process is running; for
  `'import'`, an import drain was abandoned — resume the import job.
- _`failed` send:_ provably not delivered; the next attempt with the same dedup key reclaims it.
  _`unknown` or stale `pending` send:_ never resent automatically; check the chat by hand and, if it
  wasn't delivered, decide manually whether to ask again.
- _Follow-up failure:_ nothing to repair — no question was written and extraction already succeeded.
  Repeated failures mean the provider or prompt needs attention; to stop follow-ups, pause the family
  or drop the `storyFollowup` stage.
