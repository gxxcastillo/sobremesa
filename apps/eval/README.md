# Eval

Local-only web app for comparing Scribe extraction quality across LLMs and models: run the same
message through N `{provider, model}` configs, see the extractions side by side, score against a
golden when there is one, and annotate individual extractions. Never deployed, no auth, single
local user. See `.agents/plans/eval-site-plan.md` for the design and open decisions.

Scope is Scribe-only — no Registrar, no entity merges/conflict detection, no writes to the
canonical schema. Run history and annotations live in a local SQLite file
(`apps/eval/tmp/eval.db`, gitignored), not in Supabase. Family Compare (below) is the one
exception to "no Registrar": it _reads_ already-persisted Registrar/conflict-detector output for
two existing families side by side — the app still never writes through Registrar itself.

## Running

```bash
bun nx run eval:dev
```

Starts the frontend (port `3003`, proxies `/api` to `3002`) and brings up the backend
(`eval:serve`, port `3002`) alongside it automatically, via the `dev` target's `dependsOn`. To run
the backend alone (e.g. hitting its `/api` routes directly without the frontend):

```bash
bun nx run eval:serve
```

Requires `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY` (for the "real message"
input mode's read-only family/event lookups — refuses a non-local `SUPABASE_URL` unless
`EVAL_ALLOW_REMOTE_DB=1`) and `ANTHROPIC_API_KEY` and/or `LOCAL_LLM_BASE_URL` (for whichever
provider a run's configs ask for), same as `libs/evals`.

### Local model sources

"Models to compare" offers two Ollama-backed sources, each a separate `OpenAICompatibleProvider`
config (`apps/eval/src/server/providers.ts`):

- **local** — Ollama on the machine running the eval server. Base URL from `LOCAL_LLM_BASE_URL`,
  default `http://localhost:11434/v1`.
- **lan** — a second Ollama host elsewhere on the LAN (e.g. a Windows box). Base URL from
  `LOCAL_LAN_LLM_BASE_URL`; no default, since there's no sensible guess for another machine's
  address. Running a config against this source without it set fails with a clear error.

`NewRun` fetches `GET /api/providers` on load, which probes both base URLs (`GET {baseUrl}/models`)
and returns whatever model ids each one currently reports. Selecting `local`/`lan` on a
model row prepopulates that row's model field with those ids as autocomplete suggestions (an
`<input list>`/`<datalist>`, not a closed dropdown — an id not yet pulled still works, you just type
it). A hint under the row says how many models were found and where, or that the source isn't
reachable/configured.

## Input modes

- **Curated scenario** — one of `@sobremesa/evals`'s scenario bank; scored against its golden.
- **Ad hoc text** — any typed message; unscored, raw extraction only.
- **Real message** — an actual message from an imported/live family, with the preceding messages
  as context; unscored (nothing to score against), same reason as ad hoc text.

## Seeing what an LLM was actually sent/said

Every run (`POST /api/runs`, any input kind) records the exact request(s) sent to the model and
the raw response(s), via a `RecordingProvider` wrapper around whatever provider the config
resolves to — visible on the Run Result page under "LLM calls" per config, and persisted with the
run so reopening it later still shows them. This is necessarily a **live re-run**, not a historical
record: the real pipeline never persists its own prompts or Scribe's raw output anywhere (only
Registrar's post-match summary counts reach `event_log`), so there is no way to recover what was
actually sent/returned for a message that already went through the real pipeline — only what the
same message would produce right now. The Message Trace page's "run live to see prompt & response"
button on each message uses this same path.

## Replacing LLM calls with recorded responses

Set `LLM_RESPONSE_REPLAY=1` before `bun nx run eval:serve` to substitute a stored response for a
request identical to one already made (same model + rendered system/messages/params) instead of
calling the real API — so re-running the same scenario/message against the same `{provider, model}`
config while developing this app costs nothing after the first run, as long as the prompt and model
haven't changed. This is not normal behavior: it makes a run's output depend on local disk state
rather than the live model, so it's opt-in and off by default — a normal run always calls the real
provider. A different prompt (e.g. editing `scribe.txt`) or model naturally isn't found and calls
through for real, since the lookup key is a hash of the fully rendered request — there's no
separate invalidation step. Backed by a local SQLite file (`apps/eval/tmp/llm-response-replay.db` by
default, override with `LLM_RESPONSE_REPLAY_DB`; gitignored, same as `eval.db`). Applies to every
run regardless of input mode; a substituted call still shows up in "LLM calls" via
`RecordingProvider` (see above), just with a near-zero `durationMs`.

Message Trace also surfaces _why_ a message did or didn't reach an LLM at all. It reads the latest
`intern_evaluated` `event_log` entry for the message -- the canonical, append-only record of Intern's
`route()` call, written the same way for every ingress (live chat, Studio import, CLI import) -- and
shows the action, relevance, reason, and whether the verdict was deterministic or model-backed,
alongside the downstream queue and extraction record. This is an observed pipeline result, not a
review decision: there is no override mechanism. A missing entry means the event predates the
universal `intern_evaluated` write, or nothing routed it through `InternAgent.route()` at all.

## Message Trace

A second, unrelated capability: given one or more real messages, show exactly how each moved
through the already-persisted pipeline — queue status, the `event_log` audit trail (routing
decision, filter/extraction/persist steps, errors), Intern/Scribe preprocessing artifacts, and
everything canonical that traces back to it (`claims`/`relationships.conversation_event_id`,
`people`/`places.first_mentioned_event_id`, `entity_merges.trigger_event_id`). Read-only, writes
nothing. This is the complement to the run/compare feature above, not an extension of it — that one
re-runs a message live through Scribe only (no Intern, no Registrar, no DB writes); this one shows
what already happened to a message that went through the real pipeline. Scribe's own raw extraction
is not recoverable this way — it's never itself persisted, only what Registrar did with it, and only
the following of it:

- The `understood_message` interpretation Scribe reports for itself — resolved text, confidence,
  and any ambiguous references it tracked (token, candidates considered, which one it picked, and
  how confident it was).
- Per persisted claim: `claim_analysis`'s strength/inference method, and whether the deterministic
  grounding check flagged it `grounding: 'failed'` (evidence matched neither the current message nor
  context — spec §3.4's paraphrase/hallucination case, kept rather than rejected).
- `claim_rejected` context-bleed rejections (evidence matched only a context message) — already in
  the `event_log` timeline, but called out explicitly in the "why" line too.
- The other side of each `claim_conflicts` pair a persisted claim is in, so you can see what it
  actually disagrees with, not just a count.
- `entity_merges` triggered by this message — which person/place got merged into which, by what
  strategy, and Registrar's own `merge_reason` text. This is the only record of _why_ an entity
  match/merge happened; Registrar's matching logic doesn't otherwise log its reasoning.

## Family Compare

A third, unrelated capability: pick any two already-imported families and see their aggregate
extraction counts side by side — people/places/relationships/stories/life-events, active claims
broken down by `claim_type`, `claim_conflicts`, and `claim_relationships` rows typed `contradicts`.
Each column's rows are independently clickable: clicking one drills that column into the
underlying records (a "← Back to summary" button returns to the counts), sorted deterministically
in whatever order fits the data — people/places alphabetical by name, timeline events chronological
by `date_year`, claims chronological by `claimed_at`, conflict/contradiction pairs by when the link
was recorded. Still no cross-family matching — each column's drill-down only ever queries its own
family, since `claims.subject` is free text, not a person FK, and lining up "this claim about X in
family A" with "this claim about X in family B" is a fuzzy entity-matching problem of its own.
Also includes an "Input match" panel that walks both families' raw `conversation_events` in
insertion order to flag whether they were fed the same messages, independent of the extraction
comparison below it. Routed at `/compare`, linked from the nav.

### Working backwards from a persisted entity to its source message

Every row in a Family Compare drill-down (and in the golden editor below) carries the
`conversation_event_id`/`first_mentioned_event_id` it came from (`story_conversation_events` for
stories, which can have several) and, when present, a **"trace →"** link straight to Message
Trace for that exact message — `/trace/:familyId/:eventId`, a new optional second route segment
that jumps directly to one message (fetched via the same `GET .../trace?eventIds=` call
`TraceEventRow` uses when expanded) instead of paging through the family's full timeline to find
it. This is the answer to "where did this specific claim come from, and where did it start going
wrong": one click from a suspicious extraction to the queue status, `event_log` narrative, and
"why" banner for the message that produced it.

### Build a golden

Aggregate counts and drill-down lists tell you _that_ two extractions differ, not which one is
_right_. "Build a golden" (part of the Family Compare page, below "Input match") lets you hand-curate
a real `GoldenExpectation` — the same shape `libs/evals`'s curated scenario bank uses — by pulling
whichever of Family A/B's already-persisted people/places/relationships/stories/timeline
events/claims are actually correct into it, adding anything neither model caught, and marking wrong
ones as forbidden (people/places/events/claim-subjects only — `ForbiddenExtractions` has no
relationships/stories category). Both families are then scored against that golden directly
(`POST /families/:id/score-golden`, reusing `@sobremesa/evals`'s `scoreScenario`) — a real
precision/recall/forbidden-hit verdict against already-extracted data, not a live re-run and not a
claim-count guess. One caveat: the scorer's grounding check needs a live extraction's evidence span,
which persisted `claims` rows never keep, so grounding isn't computed here — only category matching.
The draft is saved per unordered family pair in `EvalStore`'s SQLite (survives a refresh; A/B order
doesn't matter) as you edit, no explicit save step. Long families are capped to 40 visible rows per
source column with a client-side filter, since a family can have 300+ active claims.

## Import Verification

`/import-verification` is the focused before/after view for a fresh import. Choose the original and
re-imported families; it verifies source inputs by sequence number, text, and event type; counts the
fresh Intern activity by relevance (relevant / not relevant / admin, from the latest
`intern_evaluated` event per candidate event -- there is no decision table to count instead); and
lists every original message that produced active claims. For each row it shows the matching fresh
event, the latest observed Intern action/reason, and fresh active claim count, with direct links to
Message Trace. It is read-only and does not contain any hard-coded family message text.

## API

- `GET /api/scenarios` — the curated scenario bank.
- `GET /api/families`, `GET /api/families/:id/events?limit=&offset=&order=recent|sequence` —
  read-only. `order: sequence` walks `sequence_number` ascending (gapless per-family insertion
  order) for paging through an entire family; default `recent` is the original newest-first single
  page.
- `GET /api/families/:id/stats` — the Family Compare data above: per-family counts plus
  `claimsByType`. 404s on an unknown family id.
- `GET /api/families/:id/{people,places,relationships,stories,timeline-events}?limit=` — the rows
  behind each Family Compare stat, sorted deterministically (alphabetical by name for
  people/places/stories, chronological by `date_year` for timeline events, by resolved person names
  for relationships). `timeline-events` is the `events` table (extracted life events), distinct from
  `GET .../events` above (raw `conversation_events`/messages).
- `GET /api/families/:id/claims?status=&type=&limit=` — active-claims drill-down, sorted
  chronologically by `claimed_at`; `type` filters to one `claim_type`.
- `GET /api/families/:id/claim-conflicts` and `GET /api/families/:id/claim-contradictions` —
  conflict/contradiction pairs (the latter is `claim_relationships` rows typed `contradicts`), each
  claim in a pair resolved to its subject/value, sorted by when the link was recorded. Every
  drill-down route above also returns each row's `sourceEventId`/`sourceEventIds` (see "Working
  backwards..." above).
- `GET /api/family-goldens?familyIdA=&familyIdB=` — the saved golden draft for a family pair (order
  doesn't matter), or `{golden: {}, updatedAt: null}` if none saved yet.
- `PUT /api/family-goldens` — `{familyIdA, familyIdB, golden}` → upserts the draft.
- `POST /api/families/:id/score-golden` — `{golden}` → scores that family's already-persisted
  entities against the golden directly (see "Build a golden" above); no LLM call.
- `GET /api/families/:id/trace?eventIds=id1,id2,...` — the Message Trace data above, one entry per
  event id (found ones only), sorted by `sequenceNumber`. Capped at 25 ids per request. Each claim
  carries its `claim_analysis` (strength/grounding) and the other side of any `claim_conflicts` it's
  in; `produced.merges` lists `entity_merges` triggered by that event.
- `GET /api/import-verification?baselineFamilyId=&candidateFamilyId=` — read-only before/after
  input, Intern-activity, and claim-output report for a fresh import.
- `GET /api/providers` — Anthropic configured status plus each Ollama source's base URL and live
  model list (see "Local model sources" above).
- `POST /api/runs` — `{ input, configs: [{provider, model}] }` → runs the input through each
  config via `@sobremesa/evals`'s shared `runScenario`, persists, returns the full run.
- `GET /api/runs`, `GET /api/runs/:id` — list / reopen.
- `POST /api/runs/:id/annotations` — `{ target, verdict: 'good'|'bad', note? }`.
