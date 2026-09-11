# ADR-032: Unified Import Pipeline Retires Pre-Extraction Review

## Status

Accepted

## Date

2026-09-10

## Context

ADR-030 fixed _what_ judgment Studio's import review used (Intern's real router/filter, not a free
heuristic) but kept _the workflow shape_ it inherited: every import paused after parsing at
`awaiting_intern`, a human triaged each message process/skip in a two-phase queue drain
(`intern_triage.ts`'s `runInternTriage` then `runExtractionDrain`), and only human-approved events
ever reached Scribe/Registrar. That workflow is backed by `intern_decisions` — one mutable row per
`(import_job_id, conversation_event_id)`, including override state — which the API routes, Studio
client, the Studio review screen, Eval's Message Trace/`/import-verification`, and both drains all
depend on.

Re-examining that shape once the judgment itself was fixed: the review step reviews _Intern's_
per-message relevance call, not the family knowledge Scribe/Registrar later extract. Approving or
skipping hundreds of raw messages one at a time is not where a family's quality control is best
spent, and the workflow itself has costs independent of whether Intern's judgment is correct:

- It is the only reason imports (Studio and CLI) and live chat process events through structurally
  different queue shapes — a queued-but-unreviewed state live chat has no equivalent of.
- `intern_decisions` duplicates what `event_log` could already express: Intern's routing outcome is
  processing history, not mutable family-facing workflow state, and the table's override columns
  exist only to serve a UI this decision removes.
- A held-open review pauses a background pass indefinitely on browser/device/server availability —
  exactly the kind of state `AGENTS.md`'s queue-ordering and provenance rules elsewhere avoid keeping
  client-side.

Gabriel's decision (2026-09-10): retire the Studio pre-Scribe review flow, including
`intern_decisions`, rather than recreate it as browser-held state or a persistent decision table.
Every ingress persists/enqueues immediately and runs the shared pipeline's Intern → Scribe/Registrar
path without a human checkpoint in between; quality control moves to post-extraction claim/admin/
redaction review, which already exists and already operates on durable, correctable data instead of
raw messages.

## Decision

1. **No browser-held review state.** Rejected outright: private, fragile across reload/device/server
   restart, and would make a costly background pass non-resumable.
2. **No universal `intern_decisions`-shaped replacement table.** Intern's routing result is derived
   processing data, and Intern is only one pipeline step; a durable decision table generalizes a
   pattern this system deliberately does not want for every stage.
3. **One durable record: `event_log`.** Every actual `InternAgent.route()` resolution — across
   Studio import, CLI import, and live chat alike — writes exactly one `intern_evaluated` audit
   event, with an application-level typed payload (action, relevance, reason, language, and explicit
   deterministic-vs-model provenance). It is history, never a later pipeline input.
4. **`intern_decisions` is dropped, not kept in sync.** A read-optimized view derived from the log is
   permissible later; a second source of truth is not.
5. **Studio, CLI, and live chat converge on one immediate-extraction shape**: persist an event,
   queue it, and run the shared Intern → Scribe → Registrar pipeline via `buildMessagePipeline()`
   with the same stage set import already used post-ADR-030 (`router, filter, imageLinker, scribe,
registrar` — never `admin`, `historian`, or `facilitatorNudge`, so a historical import can never
   send an outbound message). The two-phase triage/extract drain and the `awaiting_intern` /
   `running_intern` / `intern_complete` / `processing_scribe` import-status states it required are
   removed; `processing_queue.intent`'s real purpose (isolating an import-scoped drain from the live
   poller so ordering and single-worker guarantees hold) is preserved but renamed away from
   `triage`/`extract` naming that implied the review phase.
6. **Raw model prompts/responses are still never persisted** in canonical Postgres. The local
   response replay SQLite cache (dev-only) is unaffected.

## Consequences

### Positive

- One pipeline shape, one completion path, for every ingress — Studio import, CLI import, and live
  chat all reach a terminal state without an extra human gate or a second drain to wire up.
- Removes a full mutable-state surface (`intern_decisions`, its RLS policies, its upsert function,
  its API routes, its Studio screen) instead of maintaining it in parallel with `event_log`.
- Eval's Message Trace and `/import-verification` read one shape (the latest `intern_evaluated`
  event) regardless of which ingress produced the event, instead of a table that only ever existed
  for one of them.

### Negative

- A human no longer gets to stop specific messages from reaching Scribe before they're extracted;
  the only correction path after this change is post-extraction (claim status, redaction, admin
  tooling). This is accepted as the intended trade — see Context.
- Studio's import UI loses a feature (per-message process/skip with override) that existed and
  worked, in favor of "upload, then background progress to completion."

### Trade-off

Optimizing for one consistent extraction shape and less durable workflow state, at the cost of losing
a pre-extraction human checkpoint. The recovery path (redaction, claim review) is judged sufficient
because false merges/wrong claims are already expected to need correction after the fact elsewhere in
the system (`AGENTS.md`: "Favor precision over recall... False merges are worse than duplicate
entities" — the system already assumes imperfect automatic judgment and a correction path, rather
than assuming a human pre-screens every message).

## Notes

- Supersedes ADR-030's **workflow-shape** decision (the two-phase triage/human-review/extract drain
  and `intern_decisions`). ADR-030's other finding — that import review, when it existed, must use
  Intern's real filter rather than a free heuristic — is subsumed here: convergence onto one shared
  pipeline call for every ingress makes that guarantee structural rather than a property of one
  review drain. ADR-030 is marked Superseded with a dated note pointing here; it is not rewritten.
- Supersedes the human-review remedy from the earlier import-filter-convergence work; that work's
  underlying finding (imports must receive Intern's real filter) remains valid and is carried
  forward by this decision, not undone by it.
- Full implementation detail: `spec/message-lifecycle.md` §4.6, `spec/data-model.md` §2.4/§2.5.
