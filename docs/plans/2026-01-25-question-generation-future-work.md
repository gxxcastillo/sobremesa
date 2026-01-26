# Question Generation: Future Work

## Background

Scribe originally generated follow-up questions about gaps in family history. The approach was:

1. LLM analyzes the message during extraction
2. Identifies missing information that would enrich the story
3. Outputs a `questions` array with priority, target (person/event/place), and story context
4. Registrar persists questions to the database for later use

## Why It Was Removed

Several issues made this approach suboptimal:

1. **No database awareness**: Scribe doesn't know what's already stored. It might generate questions about information that's already been captured in previous messages.

2. **Per-message scope**: Scribe processes one message at a time. Good questions often require understanding patterns across multiple messages (e.g., "You've mentioned several trips to Mexico - when was the first one?").

3. **Schema pressure**: Anthropic's structured outputs limit of 24 optional parameters made the question schema costly. Removing it freed 4 optional parameters for richer extraction.

4. **Separation of concerns**: Extraction (what did they say?) is fundamentally different from gap analysis (what don't we know yet?). Combining them in one agent conflates responsibilities.

## Current State

- Scribe no longer generates questions
- No `questions` in LLM output schema
- No question parsing in response-parser
- Registrar no longer persists Scribe-generated questions
- Optional parameters reduced from 22 to 18

Note: `GeneratedQuestion` type and `QuestionRepository` remain for Curator and future use.

## Recommended Future Approach: Historian

The Historian agent is the natural fit for question generation because:

### 1. Database Access

Historian already queries stored data via `DataRetriever`. It can:

- Know what claims exist for a person (avoid asking what we already know)
- Identify patterns across the family (find actual gaps)
- See the full picture, not just one message

### 2. Domain Understanding

Historian already reasons about family history:

- Understands what makes a complete person record (birth, death, relationships)
- Knows what enriches a story (locations, dates, context)
- Can prioritize based on narrative importance, not just recency

### 3. Batch Processing

Questions are better generated in batches:

- After processing N messages, analyze the accumulated knowledge
- Generate questions that span multiple recent additions
- Avoid duplicate questions about the same topic

### 4. Existing Infrastructure

Historian already has:

- `question-parser.ts` for understanding question intent
- Access to people, places, events, claims, stories
- Reasoning capabilities to identify what's missing

## Implementation Sketch

```typescript
// In Historian agent
async generateQuestions(familyId: string, options?: {
  maxQuestions?: number;
  focusAreas?: ('people' | 'events' | 'relationships')[];
  sinceDays?: number;
}): Promise<GeneratedQuestion[]> {
  // 1. Fetch recent additions (new people, events, claims)
  const recentData = await this.dataRetriever.getRecentAdditions(familyId, options?.sinceDays ?? 7);

  // 2. Identify gaps in the data
  const gaps = this.analyzeGaps(recentData);

  // 3. Generate questions about the gaps using LLM
  const questions = await this.generateQuestionsForGaps(gaps, options?.maxQuestions ?? 10);

  return questions;
}
```

## Alternative: Dedicated Questioner Agent

If Historian's scope shouldn't expand, a dedicated agent could:

- Run periodically (daily/weekly) or on-demand
- Query the full database for gaps
- Generate prioritized questions
- Consider question fatigue (don't ask too many)

## Triggering Question Generation

Options for when to generate questions:

1. **Batch job**: Daily/weekly cron that generates questions for each active family
2. **Threshold-based**: After N new extractions, generate questions
3. **On-demand**: User requests follow-up questions
4. **Facilitator-triggered**: When conversation pauses, Facilitator asks Historian for questions

## Related Files

- `libs/agents/historian/` - knowledge reasoning (recommended home)
- `libs/database/src/lib/repositories/question-repository.ts` - question persistence
- `libs/shared/types/src/lib/domain-model.ts` - `GeneratedQuestion` type
