# Facilitator AI Integration Plan

Transform the Facilitator agent from verbatim question sender to a warm, personalized communicator using the warmth formula.

## Personality Architecture

**Single Chatbot Personality Model**: All messages appear in the chat room as a single bot. Therefore:

- **Facilitator** - Owns ALL user-facing warmth and personality
- **Admin** - No personality; messages include context indicating they are admin/system messages
- **Historian** - No personality needed; focuses on accurate data querying
- **Scribe** - No personality; generates question intents (not formatted questions)
- **Registrar** - No personality; handles data storage tasks
- **Intern** - No personality; assists with backend tasks
- **Curator** - No personality; manages content curation

This ensures users experience consistent warmth and tone for story-gathering interactions. While also ensuring accurate data handling by non-personality agents.

## Overview

**Current:** Scribe generates pre-formatted questions → stored in DB → Facilitator sends verbatim
**Target:** Scribe generates raw question intent → stored in DB → Facilitator applies warmth formula via AI

## Files to Modify

| File                                                        | Changes                                           |
| ----------------------------------------------------------- | ------------------------------------------------- |
| `libs/shared/types/src/lib/entities.ts`                     | Add Question intent fields                        |
| `libs/shared/types/src/lib/domain-model.ts`                 | Add storyContext to GeneratedQuestion             |
| `libs/shared/types/src/lib/conversation.ts`                 | Add verbosity, patience to FacilitatorPersonality |
| `libs/database/src/lib/repositories/question-repository.ts` | Store new fields in createFromGenerated           |
| `libs/agents/scribe/src/lib/types.ts`                       | Add story_context to raw response                 |
| `libs/agents/scribe/src/lib/response-parser.ts`             | Parse storyContext                                |
| `libs/agents/facilitator/src/lib/facilitator.ts`            | Add Anthropic client, AI formatting               |
| `libs/agents/facilitator/src/lib/prompt-builder.ts`         | **NEW** - Build system/user prompts               |
| `apps/chatbots/src/main.ts`                                 | Pass Anthropic client to Facilitator              |
| `apps/db/supabase/migrations/`                              | **NEW** - Add question intent columns             |

## Implementation Phases

### Phase 1: Database Schema

Add columns to `questions` table:

- `question_intent TEXT` - Raw question without warmth
- `target_person TEXT` - Who to ask
- `target_event TEXT` - Related event
- `target_place TEXT` - Related place
- `story_context TEXT` - Brief story context

### Phase 2: Type Updates

**Question entity** - Add optional fields:

```typescript
questionIntent?: string;
targetPerson?: string;
targetEvent?: string;
targetPlace?: string;
storyContext?: string;
```

**FacilitatorPersonality** - Add missing fields:

```typescript
verbosity?: 'concise' | 'moderate' | 'detailed';
patience?: 'brief' | 'moderate' | 'extensive';
```

### Phase 3: Repository Update

Update `questionRepo.createFromGenerated()` to store all fields from GeneratedQuestion instead of discarding targetPerson/targetEvent/targetPlace.

### Phase 4: Scribe Update

Update response parser to extract `story_context` from Scribe's JSON output.

### Phase 5: Facilitator AI Integration

1. Add `anthropic?: AnthropicClient` to constructor options
2. Create `prompt-builder.ts` with:
   - `buildSystemPrompt()` - Load facilitator.md with personality values
   - `buildUserPrompt()` - Format question intent + context
3. Add `formatWithWarmth()` method that calls Haiku
4. Add `shouldUseAI()` heuristic (use AI if intent data present OR question unformatted)
5. Add fallback to `contentOriginal` if AI fails

### Phase 6: App Integration

Pass `anthropic` client to FacilitatorAgent in main.ts.

## Backward Compatibility

- All new DB columns are nullable
- `shouldUseAI()` checks if question already has warmth markers
- Fallback to `contentOriginal` if no intent data or AI fails
- Existing questions continue to work (sent verbatim)

## Model Selection

**Claude 3.5 Haiku** - Fast (~200ms), cheap (~$0.0001/question), sufficient for formulaic warmth transformation.

## Future Consideration: Historian Response Routing

When @ mentions route questions to Historian, the raw response should flow through Facilitator for warmth application before reaching the user. This maintains single-personality consistency.

**Not in scope for this PR** - but architecture supports it:

- Historian returns factual data
- Facilitator wraps response with warmth formula (lighter version for answers vs questions)

## Verification

1. **Unit tests**: Mock Anthropic, verify warmth formula applied
2. **Integration test**: Run `nx test agents-facilitator`
3. **Manual test**: Trigger question flow, verify message contains:
   - Warmth opener ("This story is wonderful...")
   - Clear question
   - Permission phrase ("no pressure if...")
   - Gratitude ("Thank you!")
4. **DB verification**: Check new columns populated after Scribe runs
