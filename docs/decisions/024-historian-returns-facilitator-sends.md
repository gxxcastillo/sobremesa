# ADR-024: Historian Returns Answers, Facilitator Sends

## Status

Accepted

## Date

2026-01-15

## Context

When a family member @mentions the bot with a question:

- The Historian agent queries the database and synthesizes an answer
- The answer needs to be sent to the chat with appropriate warmth
- The response should be in the same language as the question (not always PRIMARY_LANGUAGE)

Originally, the Historian sent messages directly via `BotRole.HISTORIAN`. This created issues:

- Language/personality were handled inconsistently between proactive questions and @mention responses
- Historian needed to know about warmth formula (not its core responsibility)
- Multiple bots sending messages to the family

## Decision

Historian returns answers to Facilitator for formatting and sending:

1. **Historian** generates raw answer with sources (does NOT send)
   - Returns `HistorianReply` with answer, original question, chat ID, reply-to ID
   - Logs `question_answered` event

2. **Facilitator** formats and sends via `sendResponse()`:
   - Detects language of original question
   - Applies warmth formula and personality
   - Sends via `BotRole.FACILITATOR`
   - Logs `question_responded` event

### Language Behavior

- Proactive questions: Always `PRIMARY_LANGUAGE`
- @mention responses: Match the language of the question

## Consequences

### Positive

- Single agent (Facilitator) handles all family communication
- Consistent warmth and personality across all messages
- Natural language matching for @mention responses
- Clear separation: Historian = data, Facilitator = communication

### Negative

- Extra hop for @mention responses (Historian → Facilitator)

### Trade-off

Consistency and warmth worth the additional coordination
