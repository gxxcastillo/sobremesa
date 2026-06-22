# Agent Pipeline

The system is a pipeline of seven specialised agents (`libs/agents/*`), orchestrated by
`MessageProcessor` (`libs/queue/src/lib/processor.ts`). Each agent has a single responsibility and a
typed input/output contract. The processor pre-fetches a shared `MessageContext` (recent messages +
recent images, char-limited) once per event and passes it to every agent to avoid N+1 queries.

## 3.1 Orchestration order

For each dequeued event the processor runs:

```
1. Media?              → create an Image record (async Curator callback) — non-blocking
2. Answer detection    → if the event replies to a bot question, mark that question answered
3. Router (Intern)     → ignore | admin | scribe | historian        [if a router is configured]
   ├─ ignore           → mark processed, stop
   ├─ admin            → Admin.handle(subtype)
   ├─ historian        → Historian.answer()  (+ still runs Scribe on the text)
   └─ scribe           → text pipeline ↓
4. Filter (Intern)     → relevant? (skipped when a Router is configured)
5. Scribe              → extract ScribeDomainModel
6. ImageLink (Intern)  → catch image references Scribe missed; augment the domain model
7. Registrar           → persist (dedupe, match, conflict-detect, score)
8. Facilitator         → askNextQuestion()  — fire-and-forget
```

Text events are processed **sequentially and in order** per family so pronoun/context resolution is
deterministic. Media enrichment (Curator) is asynchronous and may land later without reordering the
text stream.

The processor interfaces (`RouterProcessor`, `FilterProcessor`, `ScribeProcessor`,
`ImageLinkerProcessor`, `RegistrarProcessor`, `AdminProcessor`, `HistorianProcessor`) are defined in
`processor.ts`, and wired to concrete agents in `apps/chatbots/src/main.ts`. If no LLM provider is
configured, the AI agents are simply not wired and the bot only ingests.

## 3.2 Intern — fast pre-processor (`agents/intern`)

Lightweight, Haiku-tier. No persona. Three independent functions, all `(eventId, familyId, context?)`:

| Function        | Returns                                                                            | Job                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `filter()`      | `FilterResult{ relevant, reason, language? }`                                      | Is this message worth extracting? Fast-paths skip empty/very short messages and treat `"and…/but…"` as continuations.            |
| `route()`       | `RoutingResult{ action: ignore\|admin\|scribe\|historian, adminSubtype?, reason }` | Detects commands (`/sobremesa`, `/status`), bot mentions, DMs, member events; otherwise defers to the filter result.             |
| `linkToImage()` | `ImageLinkResult{ linked, imageId?, referenceType?, reason }`                      | Detects whether the text refers to a recently shared image (`describes \| identifies_people \| provides_context \| asks_about`). |

Reads only (`ConversationEventRepository`, `ImageRepository`); writes nothing. Prompts:
`intern-filter.txt`, `intern-image-link.txt`.

## 3.3 Scribe — extraction (`agents/scribe`)

**Responsibility:** turn one message into a structured `ScribeDomainModel`. Standard-tier model
(Sonnet by default), using **native structured output** (JSON-schema constrained) and prompt caching.

`process(eventId, familyId, context?, preprocessed?) → ScribeDomainModel`:

```ts
ScribeDomainModel {
  conversationEventId, familyId, processedAt
  people:        ExtractedPerson[]        // {name, aliases, birthYear?, deathYear?, confidence}
  places:        ExtractedPlace[]         // {name, type?, city?, region?, country?, confidence}
  events:        ExtractedEvent[]         // {title, eventType?, dateText?, dateYear?, peopleInvolved, placeName?, confidence}
  relationships: ExtractedRelationship[]  // {personAName, personBName, relationshipType, confidence}
  claims:        ExtractedClaim[]         // see below
  story?:        { title?, content, themes[], timeframe? }
  imageReferences: ImageReference[]
  detectedLanguage?, extractionVersion?, interpretation?
}

ExtractedClaim {
  claimType: 'date'|'location'|'relationship'|'detail'|'identity'
  subject, claimValue, confidence: 'high'|'medium'|'low'
  certaintyLanguage?, claimedBy, claimedBySource: 'direct'|'attributed'|'hearsay'
  referencedPeople?, referencedPlaces?
}
```

Key behaviours:

- **Extracts freely** from the _current_ message; it does **not** dedupe (Registrar's job) but avoids
  re-extracting claims already present in context messages.
- **Resolves pronouns/ambiguous references internally**, using the recent-message context; resolution
  notes go in `interpretation`.
- **Flags but never resolves** conflicts.
- **Extraction is atomic and recoverable.** `parseScribeResponse` never silently discards a non-empty
  extraction. Malformed _optional metadata_ (`understood_message`, `detected_language`) degrades to a
  safe default, but an unparseable response or invalid entity data **fails loud** — the event is not
  marked done; the queue item is retried and, on exhaustion, parked in `error` state. Because
  `conversation_events` is immutable, a parked event is always re-extractable, and a parse failure is
  never mistaken for "nothing to extract."
- Reads `ConversationEventRepository`, `FamilyRepository` (cultural terms/config), `ImageRepository`;
  writes nothing. Prompt `scribe.txt` with `{SCRIBE_NAME}`, `{CULTURAL_TERMS}`, `{THOROUGHNESS}`
  (Essential/Standard/Comprehensive), `{CONFIDENCE}` (Strict/Moderate/Lenient).

## 3.4 Registrar — persistence + resolution (`agents/registrar`)

**Responsibility:** persist the domain model into the claims-based schema. Pure TypeScript, **no LLM**
on the hot path (it may _enqueue_ claims for async LLM evaluation). It is the **single writer** of core
tables. `persist(domainModel, familyId, pipelineVersions?)` returns a `PersistResult` count summary.

Processing order inside `persist`:

1. **People** — `EntityMatcherService.matchPerson()` (fuzzy match + biographical guard); update aliases
   / enrich birth-death years on match, else create new. Track a name→id map for downstream linking.
2. **Places** — `findOrCreate` (dedupe by name/location).
3. **Events** — resolve place ids; `findOrCreate` (dedupe by title + people + date); link people.
4. **Relationships** — resolve person ids; `findOrCreate` with confidence metadata.
5. **Stories** — `findOrCreate` (dedupe by title + content overlap + theme Jaccard); when matched,
   append content, **union new `themes` and carry over `timeframe` when the existing record lacks
   one**, and link new people/places/events; link source conversation events.
6. **Claims** — the core path (per claim):
   - skip unresolved pronouns / clarification questions / invalid types;
   - resolve the subject entity id;
   - **identity claims** → merge descriptive person into the real person via `MergeHandlerService`;
   - `ConflictDetectorService.detectConflicts()` → conflicts with existing same-entity claims;
   - `StrengthCalculatorService.calculate()` → score + `needsLlmEvaluation`;
   - `ConflictDetectorService.resolveConflicts()` → `create_new | supersede_existing | mark_disputed`;
   - create the `claim` + 1:1 `claim_analysis`; link via `claim_entities` and `claim_relationships`;
   - if flagged, enqueue into `llm_evaluation_queue` (priority 100 for high-stakes, else 0).
7. **Image references** — link identified people / add context to the image.
8. **Event logging** — append a completion entry with the counts.

### Registrar services (`registrar/src/lib/services/`)

| Service                       | Contract                                                                                                                          | Logic                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------- | -------------- |
| **EntityMatcherService**      | `matchPerson(familyId, extracted) → MatchResult{ matched, existingEntityId, confidence, matchReason, suggestedAliases? }`         | Calls `personRepo.findBestMatch` (fuzzy), then rejects the match if extracted birth/death years conflict with the candidate (the "Margaret born 1950 ≠ Margaret born 1920" guard) and creates a new person instead.                                                                                                                                                                          |
| **ConflictDetectorService**   | `detectConflicts(...) → ConflictResult[]`; `resolveConflicts(newScore, conflicting) → { action, supersededClaimIds?, reasoning }` | Compares same-subject, same-type, same-entity claims by value; classifies `contradicts                                                                                                                                                                                                                                                                                                       | refines        | supports`. |
| **StrengthCalculatorService** | `calculate(claim, conflictCount, isHighStakes) → { score, factors, needsLlmEvaluation }`                                          | `score = clamp(sourceTypeScore × certaintyModifier × conflictPenalty)` where source `direct=0.95 / attributed=0.75 / hearsay=0.5`, certainty `confident=1.0 → questioning=0.4`, `conflictPenalty=0.95^conflicts`. `needsLlmEvaluation` if conflicts ∨ uncertain language ∨ hearsay ∨ high-stakes ∨ low score. `isHighStakesClaim()` covers birth/death dates, legal relationships, identity. |
| **MergeHandlerService**       | `mergeEntities(...) → EntityMerge`                                                                                                | Writes the merge record, marks the source superseded; strategy `fuzzy_match                                                                                                                                                                                                                                                                                                                  | identity_claim | manual     | llm_resolved`. |
| **InferenceEngineService**    | `generateInferences(claim, claimedBy) → InferredClaim[]`                                                                          | Derives logical claims (e.g. both spouses alive at a marriage date; life bounds from birth/death).                                                                                                                                                                                                                                                                                           |
| **LlmEvaluationService**      | (async)                                                                                                                           | Interface for LLM-evaluation queue processing; no worker drains the queue in the running app.                                                                                                                                                                                                                                                                                                |

### Identity-claim resolution

When `claimType === 'identity'` (e.g. _"Dexter's ex-wife is actually Margaret"_): find the descriptive
person and the real person; if both exist and differ, merge descriptive→real and add the descriptive
name as an alias; if only the descriptive exists, rename it and keep the old name as alias. Links are
recorded with `role: identity_source` (descriptive) and `identity_target` (canonical), and the
`claim_entities.resolved` / `entityMergeId` fields track the outcome.

## 3.5 Historian — question answering (`agents/historian`)

**Responsibility:** answer a family-history question from stored data. Standard-tier.
`answer(eventId, familyId) → HistorianReply`.

1. `parseQuestion()` classifies the question into one of 8 `QuestionType`s
   (`person_info`, `relationship`, `timeline`, `location`, `event`, `story`, `verification`,
   `general`) via heuristics (ends with `?`; starts with who/what/when/where/…; phrases like
   "tell me about").
2. `DataRetriever.retrieve()` pulls a `RetrievedContext` (people, events, stories, claims,
   relationships, images, conflicts) — merge-aware, so it follows entity-merge chains.
3. Synthesises an answer with source attribution and surfaces conflicts rather than hiding them.
4. Returns `{ success, answer, originalQuestion, chatId, replyToMessageId, questionType,
dataPointsUsed, hasConflicts, tokensUsed }`. The raw answer is handed to the **Facilitator** for
   warmth formatting and sending — the Historian itself does not send. Logs a `question_answered`
   event. Prompt `historian.txt` (`{HISTORIAN_NAME}` default `Clio`, `{PRIMARY_LANGUAGE}`).

## 3.6 Facilitator — warmth + sending (`agents/facilitator`)

**Responsibility:** ask the next pending question and send Historian answers, applying the "warmth
formula." Fast-tier (Haiku) for the cheap text transform; works without a provider (sends plain text).

- `askNextQuestion(familyId)` — throttled by a simple recently-asked interval (default ~60 min); picks
  the highest-priority `pending` question; if the target person is a verified chat participant it
  addresses them directly, else addresses the group; sends via the bot, records the external message
  id (so a reply can be matched as an answer), marks the question `asked`, logs the event.
- `sendResponse(options)` — detects the original question's language, applies response warmth
  (`facilitator-response.txt`), and replies to the original message.

Prompts `facilitator.txt` / `facilitator-response.txt` with `{FACILITATOR_NAME}`,
`{PRIMARY_LANGUAGE}`, `{CULTURAL_TERMS}`, and personality levers `{FORMALITY}`, `{VERBOSITY}`,
`{EMOJI_USAGE}`, `{ENGAGEMENT}`, `{PATIENCE}`.

## 3.7 Admin — chat operations (`agents/admin`)

**Responsibility:** handle non-extraction chat events. `handle(eventId, familyId, subtype)` where
subtype ∈ `status | dm | member_event | mention | command`:

- `status` — report queue size / recent activity for `/sobremesa`, `/status`.
- `dm` — send help/welcome.
- `member_event` — welcome on join / goodbye on leave.
- `mention` — acknowledge or redirect.

Template-driven (personality from family config: `{ADMIN_NAME}`, `{FORMALITY}`, `{AUTHORITY}`,
`{CELEBRATION}`, `{MEDIATION}`, …); sends via the bot and logs the event. Prompt `admin.txt`.

## 3.8 Curator — image vision (`agents/curator`)

`analyze(familyId, imageId, imageData: Buffer) → ImageAnalysis{ description, peopleCount?,
estimatedEra?, visibleText[], imageType?, settingHints? }`. Vision-tier (Haiku with vision; graceful
metadata-only fallback if the provider has no vision). It skips already-analysed images and writes back
via `ImageRepository.markAnalyzed()`.

The processor creates `Image` records and exposes an `onImageCreated` callback, but the running
`apps/chatbots` app does not attach the Curator. Image vision analysis is not part of the live
pipeline.

## 3.9 Model tiers (default config)

From `libs/ai-provider/src/lib/config.ts` (overridable per family / per env):

| Agent       | Tier     | Default Anthropic model              |
| ----------- | -------- | ------------------------------------ |
| Intern      | fast     | `claude-3-5-haiku-20241022`          |
| Scribe      | standard | `claude-sonnet-4-5-20250929`         |
| Historian   | standard | `claude-sonnet-4-5-20250929`         |
| Facilitator | fast     | `claude-3-5-haiku-20241022`          |
| Curator     | vision   | Haiku w/ vision                      |
| Admin       | —        | template-only (no LLM call required) |

See [`ai-providers-and-prompts.md`](./ai-providers-and-prompts.md) for the provider abstraction.
