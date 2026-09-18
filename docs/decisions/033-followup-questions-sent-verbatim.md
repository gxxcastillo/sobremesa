# ADR-033: Story Follow-up Questions Sent Verbatim (Provisional Warmth Exception)

## Status

Accepted (provisional)

## Date

2026-09-18

## Context

ADR-016 makes the four-part warmth formula (warmth + question + permission + gratitude) a
non-negotiable requirement for every outbound question — `spec/product/warmth.md` says "Every
question MUST include ALL four components," no exceptions. Story follow-up questions (ADR-031) are
different in kind: `FollowupAgent` proposes them immediately after a message that just shared a
specific story, naming a person, place, or event already in that story, to be asked once the chat
goes quiet (`story-followups-plan.md` D2). Gabriel's read on the W wording experiment
(`.agents/analysis/question-wording-labels.md`) was that the four-part wrapper reads as padding
around a question that is already warmly anchored in what was just shared, and he wanted to try
sending it plain before deciding whether to wrap it.

## Decision

`questions.origin = 'followup'` questions are sent verbatim — no warmth, permission, or gratitude
wrapper — while every other origin (`curator`, `human`) keeps the full four-part formula from
`spec/product/warmth.md`. Implemented in `FacilitatorAgent.sendQuestion`
(`libs/agents/facilitator`), keyed on `question.origin`. This is a deliberate, provisional
narrowing of ADR-016/the warmth spec's "no exceptions" rule for this one origin only — not a
general relaxation, and not a claim that warmth doesn't matter for a follow-up question.

**Revisit trigger:** if the first weeks running this against a real family feel cold, or follow-up
questions go unanswered more than other origins, add the warmth formula back for this origin.

## Consequences

### Positive

- One fewer model call per follow-up ask (no formatting pass), and no risk of a warmth pass
  diluting or hedging a wording that was already tuned and approved (`story-followups-plan.md` #0).
- Keeps the follow-up question's phrasing exactly what was tested and Gabriel approved.

### Negative

- A family may perceive follow-up questions as colder or more abrupt than the bot's other
  messages, since Facilitator's Historian-answer responses (§3.5 of `agent-pipeline.md`) and any
  future curator/human-origin questions still carry full warmth.
- Two different tones from the same persona depending on question origin, which a family member
  has no way to distinguish.

### Trade-off

Worth trying, provisionally: the wording experiment ranked story follow-ups on their concreteness
and specificity, not on warmth wrapping, and this preserves that signal while it is measured
against a real family. Explicitly revisited, not settled.
