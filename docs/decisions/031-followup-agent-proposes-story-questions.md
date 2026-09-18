# ADR-031: FollowupAgent Proposes Story Follow-up Questions

## Status

Accepted

## Date

2026-09-18

## Context

ADR-018 established a question lifecycle where "Scribe and Curator propose" questions and
Facilitator decides if/when to ask. In practice neither ever proposed one — nothing in the live
pipeline generated a `GeneratedQuestion`, so the bot never asked the family anything (see
`.agents/analysis/question-generation-approach-2026-09-14.md`). A wording experiment (W, see
`.agents/plans/story-followups-plan.md`) found that a single model call, given the source message,
the messages just before it, and the family's existing record on the people/places/events it
names, can decide well whether a live message deserves a story follow-up question and word it.

Open question: who proposes a story follow-up, when do they see message content, and how does that
interact with ADR-007 (Facilitator tracks activity, not content) and ADR-020 (human-asked
questions, still unimplemented)?

## Decision

A new agent, `FollowupAgent` (`libs/agents/followup`), proposes `questions.origin = 'followup'`
rows. It runs inside a new `storyFollowup` pipeline stage (`libs/pipeline`'s
`createStoryFollowupHook`, wired onto `MessageProcessor`) — not inside Scribe or Curator:

- It sees message content directly (the source message, five preceding messages, and the record
  context built from the message's own persisted claims). Facilitator still does not — ADR-007
  holds unchanged.
- It runs after Registrar persists on the ordinary `scribe` route, and also on Intern's `ignore`
  route: Intern's relevance filter asks "is there a fact to extract?", not "is there a story worth
  inviting?", and several of the messages worth a follow-up in the corpus this was tuned against
  were ones Intern ignored (e.g. "Way to go Leo 🥂").
- It never runs for the `admin` or `historian` routes — a command, or a question to the bot, isn't
  a story to follow up.
- It is pure decision + generation: it never persists a question or writes to the event log. The
  pipeline hook that calls it owns creating the question (`expires_at` 24 hours out) and logging
  `question_proposed`, gated by a pacing pre-check (`QuestionRepository.hasWaitingOrRecent`, 24
  hours) that skips the model call entirely when a follow-up is already waiting or was asked
  recently.
- Facilitator (§3.5 of `spec/agent-pipeline.md`) still owns _asking_: sending a proposed follow-up,
  once one exists, is gated on Facilitator's own pacing and a 30-minute chat-quiet check, and is
  sent verbatim rather than through the warmth formula (a separate, deliberate product decision —
  see ADR-033).

ADR-018's "Scribe and Curator propose" is superseded for this one origin: Scribe still extracts
claims from the same message, but proposing a follow-up question is `FollowupAgent`'s job, not
Scribe's or Curator's. ADR-020's human-origin questions remain unimplemented and unaffected.

## Consequences

### Positive

- The bot can finally propose something to ask, without giving Facilitator visibility into message
  content.
- Ignoring a message for extraction purposes and inviting a story about it are now separate
  judgments, so Intern's precision-first extraction filter no longer silently suppresses follow-ups
  too.
- Proposing and asking stay separate steps (mirrors ADR-018's original separation), so a later
  change to timing, pacing, or wording doesn't need to touch the pipeline stage.

### Negative

- A fourth place a question can come from (Scribe/Curator per ADR-018 — still unimplemented; human
  per ADR-020 — still unimplemented; now Followup) that Facilitator and Studio must keep straight
  by `origin`.
- Two model calls can now run over the same message (Scribe's extraction, Followup's formulation)
  instead of one.

### Trade-off

Worth it: this is the first landed path toward the product's stated differentiator (the bot asking
about family history), and the split keeps every existing invariant (ADR-007, Registrar as the
sole writer of extracted knowledge) intact.
