# Agent Pipeline

`MessageProcessor` (`libs/queue`) orchestrates seven agents. It fetches shared recent-message/image
context once per event and passes it through the pipeline.

## 3.1 Orchestration

```
media record? → answer detection → route
                                  ├── ignore
                                  ├── admin
                                  ├── historian answer + Scribe path
                                  └── Scribe path

Scribe path: optional filter → Scribe → ImageLink fallback → Registrar → Facilitator nudge
```

Invariants:

- Text events are processed sequentially per family.
- Historian-routed messages still run through Scribe when they contain extractable facts, but only
  once Historian's own answer succeeds — a Historian failure fails the message immediately (before
  Scribe runs) so it retries answering rather than re-running Scribe's persist path on every attempt.
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
| Admin       | Handles chat commands, DMs, member events, mentions                          | admin side effects/event log         |
| Curator     | Image vision analysis library                                                | image analysis when explicitly wired |

## 3.3 Scribe Contract

Scribe returns a `ScribeDomainModel` containing people, places, events, relationships, claims, optional
story, image references, language/version metadata, and interpretation notes.

Scribe responsibilities:

- Extract from the current message without deduplicating against the database.
- Use recent context to resolve pronouns and ambiguous references.
- Preserve uncertainty and conflicts; never resolve disputes.
- Return validated structured output. Non-empty malformed extractions fail loud so the queue can retry
  rather than silently treating the event as empty.

## 3.4 Registrar Contract

Registrar is the single writer for extracted knowledge. It:

1. Finds or creates people, places, events, relationships, and stories.
2. Applies conservative entity matching and merge rules.
3. Stores claims and links them to affected entities.
4. Detects conflicts with existing claims.
5. Computes claim strength and enqueues uncertain/high-stakes cases for async review.
6. Handles identity claims by merging or renaming descriptive placeholder people.

No LLM runs on the hot Registrar path.

## 3.5 Question Answering and Sending

Historian retrieves merge-aware context and returns an answer with source attribution and conflict
awareness. It does not send directly. Facilitator formats/sends the answer in the original question's
language and applies the warmth/personality layer.

Facilitator also asks the highest-priority pending question when allowed by the simple time throttle
configured in the chatbots app.

## 3.6 Model Tiers

| Agent       | Tier          |
| ----------- | ------------- |
| Intern      | fast          |
| Scribe      | standard      |
| Historian   | standard      |
| Facilitator | fast          |
| Curator     | vision        |
| Admin       | template-only |

Exact provider/model resolution is in [`ai-providers-and-prompts.md`](./ai-providers-and-prompts.md).
