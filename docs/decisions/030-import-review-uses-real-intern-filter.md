# ADR-030: Import Review Runs Intern's Real Filter, via an Intent-Scoped Queue Drain

## Status

Superseded (2026-09-10) — see [ADR-032](./032-unified-import-pipeline-retires-review.md). The
finding that import must use Intern's real filter, not a free heuristic, stands and is carried
forward. The **workflow shape** this ADR describes — a two-phase triage/human-review/extract drain
backed by `intern_decisions` — is retired; every ingress now runs one immediate
Intern → Scribe → Registrar pass with no pre-extraction review checkpoint. This ADR is kept
unmodified below as the historical record of the decision it made.

## Date

2026-09-04

## Context

Studio's import wizard paused every bulk import for a human review step ("Intern review": each
message marked `process` or `skip`, overridable before anything reached Scribe). That review was
never backed by Intern's real router/filter judgment — it ran a free, deterministic pre-LLM
heuristic only (`internFilterHeuristic`), the same fast-path checks `InternAgent.filter()` uses to
skip an LLM call on the obvious cases, but with no LLM fallback for anything the heuristic couldn't
resolve. `sbm import`/`POST /api/import/:jobId/run-intern` classified this way, then enqueued
approved events into the same `processing_queue` the live Telegram pipeline drains.

Verified against a real 682-message WhatsApp import in production data: `event_log` had zero
`'routed'`-stage entries for the affected family — the marker only ever written when a real
router/filter actually ran — meaning Scribe extracted directly off the heuristic's guess with no
relevance judgment applied beyond it. Concretely, five real, currently-active claims trace to this:
off-topic political/news banter (e.g. a reply to a political tweet, "Pensar que era comediante" —
"To think he was a comedian") produced a permanent claim describing an unrelated public figure as "a
comedian," despite `intern-filter.txt` explicitly listing "off-topic conversations... news" as
skip-worthy. The heuristic and the real filter were two independent implementations of the same
decision, and only the real one actually applies that judgment.

A second, structural problem stood in the way of simply calling the real filter during import
review: `processing_queue` had no column distinguishing what a given row was queued _for_. An
import review's own queued rows and the live Telegram poller's always-on drain would compete for
the exact same shared queue with no way to express "this row is awaiting human review, not ready for
extraction yet" — a scoped triage drain and the live poller's full-stage pipeline could race for the
same not-yet-reviewed row.

## Decision

Import review is powered by Intern's real filter, not a free-standing approximation, via a
two-phase queue drain:

1. **Every parsed event is enqueued unconditionally** (no separate pre-queue skip/process decision)
   — matching live's own `MessageIngester`, which never consults Intern before enqueueing either.
2. **Phase 1 (triage):** a scoped drain processes exactly this import job's queued events directly
   (by event id, not via the shared dequeue selector) through `buildMessagePipeline({ stages:
['router', 'filter'] })` — Intern's real router+filter, free rules first, LLM fallback for
   anything unresolved. Every verdict (relevant or not) is recorded into `intern_decisions` via a new
   filter-decision callback threaded through `MessageProcessor` (`event_log` only ever recorded
   _not-relevant_ verdicts; a relevant one had nowhere durable to go until this callback).
3. **Human review**, unchanged UI/UX, now backed by real judgments instead of a heuristic
   approximation.
4. **Phase 2 (extraction):** the human-approved events are re-enqueued and drained through
   `buildMessagePipeline({ stages: ['scribe', 'registrar'] })` only — `'filter'` is deliberately
   excluded, since `MessageProcessor` defaults to processing when no filter is wired, and re-running
   it would both double-pay for the same judgment and risk silently overriding a human's override.
5. A new `processing_queue.intent` column (`'live' | 'triage' | 'extract'`, default `'live'`) marks
   what a row is queued for. The shared dequeue function takes an optional intent filter; the
   always-on live poller restricts itself to `['live', 'extract']` so it can never claim a
   `'triage'`-intent row before a human has reviewed it — the concrete fix for the race above.

The free, deterministic heuristic (`internFilterHeuristic`) is not removed — it remains the fast
pre-LLM path inside Intern's real filter, restored to its original strength (media
caption-awareness, an acknowledgement word list, emoji-only detection) so both the live pipeline and
import triage skip obvious non-content for free, without ever becoming the actual decision.

Local dev (`sbm import`/`sbm process`) has no human reviewer in the loop, so it collapses phases 1-2
into `sbm process`'s own existing single default pass (already the real router/filter/scribe/registrar
pipeline) rather than running two separate drains.

## Consequences

### Positive

- Import review reflects what Intern actually decides, not a second, drifting approximation of it.
- `intern_decisions` becomes a real observability surface: every filter verdict is durably recorded,
  not just negative ones.
- The `intent` column closes a real structural race, not just the import case — any future scoped
  drain can coexist with the live poller safely.

### Negative

- Import review now costs a real LLM call per message the free heuristic can't resolve, instead of
  being free. Restoring the heuristic's full strength (this same change) keeps that volume close to
  what a live message would cost anyway.
- `run-intern`/`submit-scribe` are no longer synchronous, cheap requests — each now kicks off a
  background drain that the client polls for (same shape `POST /api/imports` already used for the
  parse/insert phase).

### Trade-off

Paying for real classification during import review is the point: a bulk import is exactly where
getting the decision wrong compounds into a large volume of wrong permanent claims, and the review
step exists so a human can catch what even the real filter gets wrong — which it can only do if
what's shown is the real judgment.

## Notes

- Supersedes an earlier import-triage proposal to use a local/deterministic embedding classifier at
  the same decision point, and retires a related import-triage rename recommendation whose premise
  ("real Intern classification already happens downstream of import") this ADR's own investigation
  found false.
- Full implementation detail: `spec/message-lifecycle.md` §4.6, `spec/data-model.md` §2.3.
