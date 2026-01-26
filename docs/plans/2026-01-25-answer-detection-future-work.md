# Answer Detection: Future Work

## Background

Scribe originally attempted to detect when messages answered pending questions. The approach was:

1. Fetch up to 10 pending questions from the database (`maxQuestions` config)
2. Include them in the LLM context as `PENDING_QUESTIONS:`
3. Ask the LLM to identify which questions were answered
4. Return `answered_questions` array with question IDs and completeness

## Why It Was Removed

Several issues made this approach problematic:

1. **Arbitrary cutoff**: Only 10 questions were included in context. Questions beyond the limit would never be matched, even if a message clearly answered them.

2. **Wrong location**: Scribe processes messages one at a time in isolation. Answer detection requires understanding the full conversation flow and question lifecycle.

3. **Incomplete implementation**: The answer content was never extracted - just marked as "answered" with empty `answerContent`.

4. **Scope creep**: Scribe's job is extraction (entities, claims, relationships, questions). Matching answers to questions is a different responsibility.

## Current State

- Scribe no longer fetches pending questions
- No `answered_questions` in LLM output schema
- No `DetectedAnswer` type in domain model
- Prompt no longer mentions answer detection

## Potential Future Approaches

### Option 1: Facilitator-Based Detection

The Facilitator agent already manages conversation flow. It could:

- Track which questions were asked and by whom
- When a response comes in, check if it addresses outstanding questions
- Use semantic similarity rather than exact matching
- Handle partial answers and follow-ups naturally

### Option 2: Dedicated Answer Resolver Agent

A specialized agent that:

- Runs periodically or on-demand
- Has access to all pending questions (no arbitrary limit)
- Analyzes recent conversation history holistically
- Can handle multi-turn answer patterns

### Option 3: Registrar-Based Detection

Since Registrar already handles entity matching and persistence:

- Extend it to match extracted claims against question subjects
- Use claim content to infer question answers
- Leverage existing entity resolution for matching

### Option 4: Historian-Based Detection

The Historian already answers questions about family history. It could be extended to detect answers:

- Already has question parsing capabilities (`question-parser.ts`)
- Understands the domain and has access to relevant data via `DataRetriever`
- Could recognize when someone is _answering_ a question, not just _asking_ one
- Natural fit since it already deals with questions conceptually

Trade-off: Historian is currently a "read" operation (query history). Answer detection is a "write" operation (mark questions as answered). This would expand its scope significantly.

## Recommendation

Consider Option 1 (Facilitator) or Option 4 (Historian) as the most natural fits:

- **Facilitator** already manages conversation flow and could detect answers during its normal operation
- **Historian** already has question-parsing infrastructure and domain understanding

A hybrid approach might work: Facilitator detects potential answers in real-time conversation flow, then delegates to Historian's question-matching logic to confirm the match.

## Related Files

- `libs/agents/facilitator/` - conversation flow management
- `libs/agents/scribe/` - entity/claim extraction (current)
- `libs/agents/registrar/` - persistence and entity matching
