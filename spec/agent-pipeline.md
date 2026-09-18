# Agent Pipeline

`MessageProcessor` (`libs/queue`) orchestrates eight agents. It fetches shared recent-message/image
context once per event and passes it through the pipeline.

## 3.1 Orchestration

```
media record? → answer detection → route
                                  ├── ignore → story follow-up
                                  ├── admin
                                  ├── historian answer + Scribe path
                                  └── Scribe path → story follow-up

Scribe path: optional filter → Scribe → ImageLink fallback → Registrar → Facilitator nudge
```

Invariants:

- Text events are processed sequentially per family.
- Historian-routed messages still run through Scribe when they contain extractable facts, but only
  once Historian's own answer succeeds — a Historian failure fails the message immediately (before
  Scribe runs) so it retries answering rather than re-running Scribe's persist path on every attempt.
- Story follow-up (§3.6) runs on the `ignore` and `scribe` routes only, never `admin` or
  `historian` — a command, or a question to the bot, isn't a story to follow up.
- Curator image analysis is not attached in the live app.
- If the default AI provider resolves to `mock`, only Admin and plain-text Facilitator behavior are
  wired; routing/extraction/Q&A agents are not attached.

## 3.2 Agents

| Agent       | Role                                                                         | Writes                               |
| ----------- | ---------------------------------------------------------------------------- | ------------------------------------ |
| Intern      | Fast routing/filtering and image-reference fallback                          | logs/processing metadata only        |
| Scribe      | Extracts a structured domain model from one message plus recent context      | none                                 |
| Registrar   | Persists entities, relationships, stories, claims, conflicts, scores, merges | core data tables                     |
| Historian   | Answers user questions from stored family data                               | event log; sending delegated         |
| Facilitator | Sends Historian answers and asks pending warm follow-up questions            | questions/event log                  |
| Followup    | Decides whether a message deserves a story follow-up question, and drafts it | none (the pipeline hook persists)    |
| Admin       | Handles chat commands, DMs, member events, mentions                          | admin side effects/event log         |
| Curator     | Image vision analysis library                                                | image analysis when explicitly wired |

## 3.3 Scribe Contract

Scribe returns a `ScribeDomainModel` containing people, places, events, relationships, claims, optional
story, image references, language/version metadata, and interpretation notes.

Scribe responsibilities:

- Extract from the current message without deduplicating against the database.
- Use recent context to resolve pronouns and ambiguous references. The pipeline supplies recent
  messages oldest-to-newest with compact local timestamps, plus explicit `IN REPLY TO` and
  `IN REPLY TO QUESTION` blocks when the current message replies to a known message or tracked bot
  question.
- Preserve uncertainty and conflicts; never resolve disputes.
- Return validated structured output. An explicit `null` on an optional field (the model's own way
  of saying "no value") is normalized to absent rather than treated as malformed. Non-empty
  malformed extractions still fail loud so the queue can retry rather than silently treating the
  event as empty.
- Never assert who is speaking. Claims carry `claimed_by_source` (direct/attributed/hearsay) and,
  only for attributed/hearsay claims, `attributed_to` — the person the speaker attributes the fact
  to (e.g. "Mom always said..." → `attributed_to: "Mom"`). Scribe does not output a speaker name;
  the pipeline stamps that deterministically (see §3.4).
- Every claim carries a required `evidence` field: a short verbatim span from the current message
  supporting the claim (never paraphrased, never quoted from context). A claim without evidence
  fails the parse loud, like any other malformed entity data. The Registrar verifies the span
  deterministically (see §3.4).
- Bare agreements with another family member's context message assert a stance, not the fact (the
  fact was already extracted from the original message) — no claim is emitted. Confirming a tracked
  bot question is the exception: bot questions are never themselves recorded, so a confirmation
  asserts the confirmed fact, evidenced by the reply's own words.

## 3.4 Registrar Contract

Registrar is the single writer for extracted knowledge. It:

1. Finds or creates people, places, events, relationships, and stories.
2. Applies conservative entity matching and merge rules. A descriptive name or alias (e.g. "Ralph's
   sister", "la tía de Juan" — anything `classifyPersonName` in `shared-utils` flags as relational or
   generic) may only match an existing person by exact name or alias equality; it is never eligible
   for first-name or fuzzy matching, so a description of a relative can never be merged into the
   person it describes a relative _of_. When no real person matches, a `relational` description
   (never `generic`) reuses an existing placeholder person whose `name` (never its aliases, which may
   carry speaker-relative terms) is an exact normalized-name match — otherwise a new placeholder is
   created. This is the only path that matches against placeholders; `findBestMatch` excludes them.
   Speaker-relative aliases (`"mi tía"`, `"my mom"` — `isSpeakerRelativeTerm` in `shared-utils`) are
   never searched or stored durably, since they name a different person for every speaker; they are
   still registered for the current message only, so a claim subject in the same message can resolve
   one.
3. Stores claims and links them to affected entities.
4. Detects conflicts with existing claims.
5. Computes claim strength and enqueues uncertain/high-stakes cases for async review.
6. Handles identity claims by merging or renaming descriptive placeholder people.

Conflict detection (`detectClaimConflict`) only compares claims of the same singular claim type
(date, location, identity, relationship — never additive `detail`) with matching subjects. Within
that, two rules keep noisy field-level differences from becoming a false disagreement (#5d): a
free-text citation/explanation field (`text`, e.g. a date claim's `"at age 43"` vs. `"8 years ago"`)
is ignored when a structured field already exists to compare instead, and becomes the fact being
compared only when it's the only value either side has. A `relationship`-type claim only conflicts
with another when both name the same counterparty (compared with the same whole-word-token
precision bar used for subject matching) and disagree on `relationshipType` — "sibling to her
brothers" and "great-grandchild to our grandparents" are compatible facts about different people,
not a contradiction; missing or ambiguous counterparty evidence on either side makes the pair not
comparable rather than a confident conflict.

No LLM runs on the hot Registrar path.

Claim attribution is pipeline-stamped, never LLM-derived: `claims.claimed_by` is always the
deterministic sender name from the source `conversation_events` row, and `claims.claimed_by_identity_id`
is resolved from that row's `(source, actor_external_id)` via the identity repository — never from
extracted text, so a claim can never be misattributed regardless of what the extraction contained.
`claimed_by_identity_id` is `NULL` when no identity exists for the source (e.g. WhatsApp import
participants, which are `people` records, not `identities`). `attributed_to`, when present on the
extraction, is persisted verbatim as free text — it is not entity-resolved and carries no
attribution guarantee beyond what the speaker said.

Every claim's `evidence` span is verified deterministically before persistence (grounding check).
The span and the candidate texts are normalized identically (lowercase, diacritics folded,
punctuation collapsed) and containment is whole-word anchored. Three-way rule:

- Evidence appears in the current message → grounded; the claim persists normally.
- Evidence appears only in a prior context message (the recent window or the replied-to message,
  both supplied by the processor) → definite context bleed; the claim is **rejected** before it can
  drive entity resolution or merges, with a WARN log and a `claim_rejected` event-log entry.
- Evidence matches neither → the claim persists but its claim-analysis `strength_factors` records
  `grounding: 'failed'` (paraphrase and hallucination are indistinguishable here; the rate is
  measured by the eval harness before any escalation to rejection).

The answered-bot-question text is deliberately excluded from the bleed check: bot outbound text is
never extracted, so evidence matching only a bot question flags rather than rejects. A message with
no retrievable content (e.g. media without caption) can only flag, never reject.

## 3.5 Question Answering and Sending

Historian retrieves merge-aware context and returns an answer with source attribution and conflict
awareness. It does not send directly. Facilitator formats/sends the answer in the original question's
language and applies the warmth/personality layer.

The send itself goes through `BotManager`'s classified, at-most-once-per-dedup-key contract
(`message-lifecycle.md` §4.3): Facilitator reads back the delivered message id from a `'sent'`/
`'duplicate'` outcome (still used to record which external message a question was asked as) and
otherwise treats a definitive delivery failure and an ambiguous one differently, never resending into
a possible duplicate.

Within one retrieval, claims are ordered by `claim_analysis.claim_strength` (recency as tiebreak)
before any per-query cap is applied, so a subject with more claims than the cap surfaces its
strongest evidence rather than whatever was recorded most recently.

Conflicts shown to a family are read from the links Registrar already persisted in
`claim_relationships` (`relationship_type = 'contradicts'`), not re-derived from value inequality
across whatever one retrieval strategy happened to fetch. Registrar writes that edge in one direction
only (the newer claim → the older claim it disputes), so Historian checks both directions for every
retrieved claim, and fetches the contradicting claim from the database when the retrieval strategy
didn't already have it — a conflict recorded months apart still surfaces even though a single query
wouldn't have fetched both sides.

Facilitator also asks the highest-priority pending question when allowed by a simple time throttle
(default 60 minutes; the chatbots app overrides it to 1440 minutes/24 hours -- story-followups-plan.md
D2/#5). The throttle is keyed on the most recent `asked_at` across all questions for the family
regardless of their current status: an answered or retired question was still asked, so it still
counts toward pacing how often the bot speaks.

Before picking a question to ask, Facilitator retires any `origin: 'followup'` question past its
`expires_at` (`question_retired`, reason `expired`) — cleanup only, since the pending query already
excludes expired rows on its own. A `'followup'`-origin question also carries its own additional
gate on top of the throttle above: it is asked only once the family's chat has been quiet for 30
minutes (`ConversationEventRepository.findMostRecentOccurredAt` — activity only, never content, so
ADR-007 still holds). No prior activity at all means nothing to wait on. Every other origin has no
such gate.

## 3.6 Story Follow-ups

An independent `storyFollowup` pipeline stage (`libs/pipeline`'s `createStoryFollowupHook`, wiring
`FollowupAgent` from `libs/agents/followup`) decides whether a live message deserves a follow-up
question about family history, separately from Registrar's extraction. It runs after
`MessageProcessor.process()` handles the message, either after Registrar persists (the `scribe`
route) or in place of the early return on the `ignore` route -- Intern's relevance filter answers
"is there a fact to extract?", not "is there a story worth inviting?", so a message Intern ignored
(e.g. "Way to go Leo 🥂") can still get a follow-up. It never runs for `admin` or `historian`: a
command, or a question to the bot, isn't a story to follow up. A failure earlier in `process()`
throws before the hook runs, and any error the hook itself raises is caught and logged there --
a follow-up can never fail or retry a message that otherwise succeeded.

The hook first checks pacing (`QuestionRepository.hasWaitingOrRecent`, 24 hours): a non-expired
proposed question already waiting, or one asked within the last 24 hours, skips with no model call.
Otherwise `FollowupAgent.formulate()` decides using the source message, the 5 messages before it,
and the record context (people/places/events the message names, each one's claim history). Named
entities are normally found through the claims the current message produced; a message with none
(e.g. one Intern ignored) falls back to a bounded, read-only whole-word name match against the
family's active people/places (`textMentionsName`, capped at 3 each side, placeholders and
ambiguous shared names excluded) so a known person's history isn't blind to imported context just
because this particular message created no claims (#10). The fallback never merges entities or
writes claims. Sonnet 5 (`claude-sonnet-5`, pinned for this agent only via
`AGENT_MODEL_RECOMMENDATIONS.followup`'s
`modelPin`), no `temperature`, schema embedded in the system prompt. `FollowupAgent` is pure
decision + generation: it never persists anything or writes to the event log. On `ask`, the hook
creates the question (`origin: 'followup'`, `source_message_id` the source event,
`expires_at` 24 hours out) and logs `question_proposed`. Asking it is Facilitator's job (§3.5),
gated on its own pacing, expiry retirement, quiet-chat check, and conservative-cancellation check
(§4.4 of `message-lifecycle.md`), and sent verbatim rather than
through the warmth formula (§3.5, `spec/product/warmth.md`, ADR-033). Nothing requests the
`storyFollowup` pipeline stage yet, so no follow-up is proposed in production today regardless.

## 3.7 Model Tiers

| Agent       | Tier                          |
| ----------- | ----------------------------- |
| Intern      | fast                          |
| Scribe      | standard                      |
| Historian   | standard                      |
| Facilitator | fast                          |
| Followup    | standard (pinned to Sonnet 5) |
| Curator     | vision                        |
| Admin       | template-only                 |

Exact provider/model resolution is in [`ai-providers-and-prompts.md`](./ai-providers-and-prompts.md).
