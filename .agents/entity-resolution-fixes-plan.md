# Entity-Resolution Fixes — Implementation Plan

Source: verified code review of commit `967fece` ("improved entity resolution"). This file plans the
**code** changes; the **spec** decisions they realize are already written into `spec/` (see
`spec-editorial-state.md` for the spec-ahead-of-code drift notes that each item below clears).

## Guiding principles

1. **Precision over recall** (new `overview.md` invariant 6). A false merge destroys a distinct memory
   and is strictly worse than a missed merge (a recoverable duplicate). Heuristics must be
   _structurally anchored_ (word boundaries, date windows, people overlap), not loose substring or
   bare score thresholds.
2. **No silent, unrecoverable data loss.** A failed extraction must never be mistaken for an empty one.
   Since `conversation_events` is immutable, every failure must remain re-extractable.
3. **Fix the class, not the cited instance.** Each item below states its _class scope_ — the sibling
   sites found while auditing, not just the one line in the review.

## Sequencing

- **Spec edits — DONE** (this session): `overview.md` inv. 6, `agent-pipeline.md` §3.3 & §3.4 step 5,
  `data-model.md` §2.2.
- **P0 — DONE** (silent data loss + graph corruption): #6 ✓, #4 ✓, #1/#2 ✓. All typecheck, lint, and
  unit-tested; full `nx run-many -t types test` green across 19 projects.
- **P1 — DONE** (same-root over-merge + enrichment + vocab): #5 ✓, #3 ✓, #7 ✓, #8 ✓.
- **P2 — TODO** (correctness/i18n): #9, #10.

### P0 landed — what shipped

- **#6** `response-parser.ts` now throws `ScribeParseError` on invalid JSON / invalid entity data
  (never silent-empty); `schema.ts` degrades only `understood_message` + `detected_language` via
  `.catch()`. New `response-parser.spec.ts` (8 tests) + test scaffolding (`vite.config.ts`, `test`
  target). Recovery chain verified: throw → processor catch → `success:false` → `queueRepo.fail()` →
  retry/dead-letter; immutable event stays re-extractable.
- **#4** new `name-match.ts` (`textMentionsName`, Unicode-aware word-boundary match) replaces the
  unbounded substring in `registrar.ts`; `name-match.spec.ts` (6 tests).
- **#1/#2** `timeline-event-repository.ts` `findSimilar`: hard `MAX_YEAR_GAP` date filter + closed the
  3–5yr gap (#1); requires a structural anchor (person overlap or date corroboration), so title-only
  merges no longer happen (#2). Named scoring constants. 4 new tests; existing tests updated.

Each code item lands with: the matching `spec-editorial-state.md` drift note removed, unit tests for the
failure scenario, and a short note in the PR description.

### P1 landed — what shipped

- **#5** `conflict-detector.ts` now scores subject matches with whole-token Jaccard, removes raw
  substring containment, and exposes `findBestSubjectMatch()` with a minimum runner-up margin.
  `registrar.ts` uses it for claim→event resolution, so weak or ambiguous event subjects are not
  promoted to primary `event` links. New `conflict-detector.spec.ts` covers substring rejection, best
  candidate selection, and ambiguity.
- **#3** `story-repository.ts` `findSimilar` now requires a structural gate: titled stories need a real
  title anchor; untitled stories need person+theme corroboration plus content similarity. New
  `story-repository.spec.ts` covers the previous untitled over-merge class.
- **#7** `appendToStory()` now unions themes and fills `timeframe` only when the existing story lacks
  one; `findOrCreate()` passes the extracted enrichment data through. Tests cover theme union and
  no-overwrite timeframe behavior.
- **#8** `schema.ts` now normalizes controlled vocabularies at the Scribe layer: place types, event
  types, relationship types, and image reference types. Optional descriptive types (`place.type`,
  `event_type`) drop unknown values without dropping the extraction; unknown structural
  `relationship_type` fails loud. `scribe.txt` names the allowed values, and parser tests cover
  normalization/failure behavior.

---

## P0

### #6 — Scribe extraction: atomic & recoverable _(highest priority — silent permanent data loss)_

**Root cause.** `parseScribeResponse` (`libs/agents/scribe/src/lib/response-parser.ts:127`) returns
`createEmptyDomainModel` on _any_ `safeParse` failure, without throwing. The empty model flows through
Registrar (persists nothing) and the processor calls `queueRepo.complete()`
(`libs/queue/src/lib/processor.ts:633`) → `status='done'`. The message is never re-extracted. A parse
failure is indistinguishable from "successfully extracted nothing." The retry/dead-letter machinery
(`processing-queue-repository.fail()`, `message-queue.ts:136`) exists but is never engaged.

**Class scope.** Not just `understood_message`. Live triggers include `detected_language`
(`schema.ts:112` — `z.enum` with no default; an out-of-list language like `'it'` fails the whole
parse) and any malformed entity element. The fix is the _contract_, not one field.

**Decided design — strict fail-closed + recover.**

1. **Metadata can't cause loss.** Add Zod `.catch()` to the non-data fields so they degrade instead of
   failing the parse:
   - `understood_message: UnderstoodMessageSchema.optional().catch(undefined)`
   - `detected_language: z.enum([...]).catch('unknown')`
   - **Entity arrays must NOT get `.catch([])`.** They keep `.default([])` (absent → empty) only.
     `.catch([])` would silently swallow a malformed entity element and its siblings — exactly the
     silent-loss class this item exists to kill. Malformed entity data must reach the throw in step 2,
     consistent with spec §3.3 ("invalid entity data fails loud"). Only the two metadata fields above
     degrade.
2. **Distinguish hard failure from empty.** On invalid JSON or entity-validation failure,
   `parseScribeResponse` must **throw** (or return a typed failure the Scribe agent rethrows) instead
   of returning empty. `scribe.ts:process()` already rethrows on provider errors (line 217) — route
   parse failure the same way.
3. **Fail loud → recover.** A thrown parse failure propagates to `processor.ts` catch (line 655) →
   `success:false` → `message-queue.ts` → `queueRepo.fail()` → retry up to `maxRetries`, then
   `status='error'` (dead-letter). `complete()` is never called on failure. The immutable event stays
   re-extractable.
4. **Never persist partial.** With strict fail-closed we do not salvage a subset; the whole message
   re-extracts on retry. (Salvage-and-flag was rejected: it would lean on Registrar dedup idempotency,
   which #1–#5 currently make unreliable.)

**Operational follow-up (flag for decision).** Dead-lettered (`status='error'`) events need visibility
so they don't sit unnoticed — confirm there is alerting/a drain path on the `error` state, or add one.

**Files.** `response-parser.ts`, `schema.ts`, `scribe.ts`; verify `processor.ts` / `message-queue.ts`
failure routing; check `maxRetries` config.

**Tests.** malformed `detected_language` → full extraction still succeeds (degrade); invalid JSON →
throws → event NOT `done`, attempts incremented, eventually `error`; legitimately-empty message →
completes normally (no false failure).

---

### #4 — Claim→person linking: unbounded substring match _(graph corruption)_

**Root cause.** `registrar.ts:~1272` links a person when
`claimText.includes(personName.toLowerCase())` with only a `length < 3` guard. 'Ann' matches inside
'Anna'/'banana'; writes a spurious `claim_entities` row (role `related`) that permanently pollutes the
graph.

**Class scope.** Audit every `.includes(` / substring containment used for entity matching in
`registrar.ts` (subject parsing, alias matching) and `conflict-detector.ts` `subjectsMatch` — the same
unanchored-match pattern recurs (see #5).

**Fix.** Token/word-boundary matching: tokenize `claimText` and match whole tokens (and alias tokens)
rather than raw substring; keep a sensible min-length. Reuse the project's existing tokenizer if one
exists (the story/event scorers already `tokenize`).

**Files.** `registrar.ts`; shared matching helper (see cluster note).

---

### #1 — Timeline dedup: date proximity is a soft penalty with a logic gap _(over-merge)_

**Root cause.** `timeline-event-repository.ts:193–200`: `yearDiff <= 2` → `+0.15`, `yearDiff > 5` →
`-0.2`, and **3/4/5-year gaps fall through to no adjustment at all** (literal missing branch). The old
hard `±2yr` SQL filter is gone. 'Birthday Party' 1950 vs 1990 with a shared person scores
`1.0 + 0.1 − 0.2 = 0.9 ≥ 0.6` → merged; 3–4yr apart scores `1.1`, no penalty.

**Fix (precision).** Restore a **hard date window** as a candidate pre-filter when `dateYear` is known
on both sides (mirror the old `±N yr` SQL gate), so out-of-window candidates are excluded outright, not
merely penalized. Keep soft scoring only within the window. Close the 3–5yr gap regardless.

**Files.** `timeline-event-repository.ts` (`findSimilar`).

---

### #2 — Timeline dedup: title-only merge when no people resolve _(over-merge)_

**Root cause.** `timeline-event-repository.ts:158–159`: empty `personIds` now falls back to
`findAllActive` and scores on title alone; old code returned `null` early ("can't dedup without
people"). A generic-titled event ('lunch', 'the trip') with no resolved people scores `1.0 ≥ 0.6`
against any title-overlapping event → wrong merge.

**Fix (precision).** When `personIds` is empty, do **not** dedup on title alone. Either return `null`
early (restore old behavior) or require a much stronger gate (exact normalized title **and** date-year
match). Decide with #1's date-window helper so the two share one notion of "same event."

**Files.** `timeline-event-repository.ts` (`findSimilar`).

---

## P1

### #5 — Claim→event resolution: first-match-wins attaches to wrong event _(over-merge)_

**Root cause.** `registrar.ts:~773` + `conflict-detector.ts:112`: first `subjectsMatch` (`>= 0.5`
overlap + substring shortcut) over _all_ events wins; 'the wedding day' matches an unrelated 'wedding'.
When no person resolved, `entityType` is even promoted to `'event'` pointing at the wrong record.

**Fix.** Score all candidates, take the **best** with a minimum margin over the runner-up; raise the
threshold; remove the bare substring shortcut (word-boundary, per #4). Do **not** promote `entityType`
to `'event'` on a weak/ambiguous match. Shares the matching helper with #4.

**Files.** `registrar.ts`, `conflict-detector.ts`.

### #3 — Story dedup: over-merges distinct untitled stories _(over-merge)_

**Root cause.** `story-repository.ts:~279`: two different untitled stories from the same person can hit
exactly the inclusive `>= 0.55` gate (`0.1 both-untitled + content + themes + person`).

**Fix.** Require a _structural_ gate, not a soft sum: e.g. demand title match **or** strong person+theme
overlap before content alone can cross the line; re-tune the threshold under invariant 6. Coordinate
with #7 (enrichment runs only after this gate is trusted).

**Files.** `story-repository.ts` (`findSimilar`).

### #7 — Story merge enrichment: themes/timeframe dropped

**Root cause.** On match, `findOrCreate` (`story-repository.ts:330`) calls `appendToStory`, which
updates only `content_original` (lines 172–174). New `themes`/`timeframe` are discarded →
`findByTheme` (lines 46–52) under-recalls merged stories. (Entity-linking on merge is already correct
in `registrar.ts:603–671`; only themes/timeframe are missing.)

**Fix.** Extend `appendToStory` (and its one call site) to **union `themes`** into the existing set and
set `timeframe` when the existing record lacks one. Themes are additive — no false-merge risk.
`completeness` staleness is **deferred** (needs a rubric; out of scope here).

**Files.** `story-repository.ts`.

### #8 — Controlled-vocabulary `_type` fields free-form at extraction

**Root cause / class.** `967fece` dropped the DB `valid_place_type` CHECK, and the Scribe schema types
**four** fields as free-form `z.string()`: `place.type` (`schema.ts:22`), `event_type` (:30),
`relationship_type` (:46), `reference_type` (:78). Only one consumer switches on a value today
(`entity-matcher.ts:366`, `place.type === 'country'`, fails safe), but free-form vocab degrades match
quality and future dedup.

**Decided.** Normalize at the **Scribe (Zod) layer**, leave the DB free-form (no migration coupling).

**Per-field recommendations (need a quick decision before coding):**

- `place.type` → **enum** `city|country|address|region|landmark|neighborhood|building` _(decided)_.
- `reference_type` → **enum** `describes|identifies_people|provides_context|asks_about` (spec §3.2
  already names these — clear win).
- `relationship_type` → **enum aligned to `RelationshipType`** in `entities.ts` (Core + Extended), with
  a normalization map for LLM variants; verify the registrar's relationship parsing tolerates it.
- `event_type` → **verify domain first.** Derive the enum from existing event-type usage / any
  `valid_event_type` on the events table; if the domain is genuinely open, keep free-form + document.

**Files.** `schema.ts`; possibly a small normalization map; `entity-matcher.ts` consumer check.

---

## P2

### #9 — `dateYear` lost during date normalization

**Root cause.** `response-parser.ts:57` `normalizeDateText` string-sniffs a JSON-object date, but
`extractYear` (defined :46, called on raw `e.date` at :189) still runs on the **raw** value.
`{"year":92,...}` → 4-digit regex finds no
year → `dateYear` silently lost; only works for `{"year":1992}` by accident.

**Fix.** Parse the date once, authoritatively: if the value is a structured object, read `year`
directly; run `extractYear` only on the normalized text. Remove the string-sniff bandaid.

**Files.** `response-parser.ts`.

### #10 — Possessive subject parsing is English-only _(i18n regression)_

**Root cause.** Two sibling sites — `registrar.ts:754` (person possessive) and `:768` (event
possessive) — use `claim.subject.includes("'s ")` + `split("'s ")`; won't match
Spanish/Portuguese/French possessives ('la boda de María') — the exact languages `detected_language`
was widened to in this same commit. Fix **both**.

**Fix (preferred) — note this requires a schema addition first, it is NOT a drop-in.** The structured
`referencedPeople` the registrar reads (`registrar.ts:1209-1210`) is **never populated**: it is on the
`ExtractedClaim` type (`domain-model.ts:62`) but absent from the Scribe `ClaimSchema`
(`schema.ts:61-74`) and never set by `parseScribeResponse` (`:204-212`) — so that registrar branch is
currently dead code. To use it, first add `referenced_people` to `ClaimSchema` + the parser mapping,
then resolve subject→person from it, falling back to multilingual possessive patterns only if needed.
If that schema work is out of scope, the interim fix is to broaden the possessive patterns at both
sites to cover Romance "de"/"de la"/"du" forms.

**Files.** `registrar.ts` (both `:754` and `:768`); `schema.ts` + `response-parser.ts` if doing the
`referenced_people` route.

---

## Shared work / cross-cutting

- **Matching helper.** #4 and #5 (and the substring shortcuts in `conflict-detector.subjectsMatch`)
  should share one word-boundary/token matcher with documented thresholds, referencing invariant 6.
- **Scoring constants.** #1/#2/#3 thresholds and date windows should live as named, commented constants
  (per repository or a shared module) rather than inline magic numbers, so the precision/recall point
  is reviewable in one place.

## Open decisions (do not block P0)

1. `event_type` and `relationship_type` enum domains (#8) — verify before coding.
2. Dead-letter visibility/alerting for `status='error'` (#6 operational follow-up).
3. `completeness` ladder for stories (#7 deferred) — needs a rubric.
