# Sobremesa Agents

High-level overview of the AI agents that power Sobremesa's family history collection system.

---

## The Seven Agents

| Agent           | Role                      | Visible? | Calls Claude API? | Model  | Prompt File                               |
| --------------- | ------------------------- | -------- | ----------------- | ------ | ----------------------------------------- |
| **Facilitator** | Asks questions & responds | Yes      | Yes               | Sonnet | `libs/prompts/src/agents/facilitator.txt` |
| **Historian**   | Answers @mention queries  | No       | Yes               | Sonnet | `libs/prompts/src/agents/historian.txt`   |
| **Admin**       | Celebrates & mediates     | Yes      | Yes               | Sonnet | `libs/prompts/src/agents/admin.txt`       |
| **Scribe**      | Extracts data             | No       | Yes               | Sonnet | `libs/prompts/src/agents/scribe.txt`      |
| **Curator**     | Analyzes photos           | No       | Yes               | Sonnet | `libs/prompts/src/agents/curator.txt`     |
| **Intern**      | Filters & links images    | No       | Yes               | Haiku  | `libs/prompts/src/agents/intern-*.txt`    |
| **Registrar**   | Saves to database         | No       | No                | N/A    | None (pure logic)                         |

---

## System Flow

### Normal Message Processing

```
1. Message arrives in Chat Provider
   ↓
2. Stored in conversation_events table
   ↓
3. Added to ordered queue
   ↓
4. Intern routes message
   ├─ @mention question → Go to "Question Answering" flow
   ├─ NOT RELEVANT → Mark processed, skip to step 8
   └─ RELEVANT → Continue
   ↓
5. Scribe processes (extracts entities, creates claims)
   ↓
6. Intern links images (catches image references Scribe missed)
   ↓
7. Registrar saves (domain model → database)
   ↓
8. Facilitator checks if should ask question
   ├─ YES → Asks warmly in PRIMARY_LANGUAGE
   └─ NO → Waits (logs reason in event_log)
   ↓
9. Admin monitors and adjusts
   ├─ Celebrates milestones
   ├─ Mediates conflicts
   └─ Coaches Facilitator
```

### Question Answering (@mentions)

```
1. @mention question routed by Intern
   ↓
2. Historian queries database
   ├─ People, claims, relationships
   ├─ Events, stories, images
   └─ Detects conflicts
   ↓
3. Historian synthesizes raw answer
   ├─ Source attribution
   ├─ Confidence levels
   └─ Conflict presentation
   ↓
4. Facilitator receives answer
   ├─ Detects question language
   ├─ Applies warmth + personality
   └─ Sends in QUESTION language
   ↓
5. Event log updated
   ├─ question_answered (Historian)
   └─ question_responded (Facilitator)
```

---

## Question Lifecycle

A "question" is a first-class object with its own lifecycle. Multiple agents participate, but only the Facilitator speaks to the family.

### System-Generated Questions (Proactive)

1. **Propose** (Curator) - Store in questions table with priority + context (from image analysis)
2. **Decide if/when to ask** (Facilitator) - Apply rules, rate limits, warmth formula
3. **Persist state** (Registrar) - Update question status (asked/answered/retired)
4. **Adapt behavior** (Admin) - Monitor outcomes, adjust rules

### User @Mention Questions (Reactive)

1. **Route** (Intern) - Detect @mention with question pattern
2. **Answer** (Historian) - Query database, synthesize answer with sources
3. **Format & Send** (Facilitator) - Apply warmth, send in question's language

**Key rule:** Facilitator is the ONLY agent that sends messages to the family.

---

## Agent Specifications

### Facilitator (Default: "Carmencita")

**Role:** Ask warm questions AND send formatted responses to @mentions

**Internal Name:** `BotRole.FACILITATOR`

**Language Behavior:**

- **Proactive questions:** Always use configured `PRIMARY_LANGUAGE`
- **@mention responses:** Match the language of the original question

**Decision Logic (priority order):**

1. Real-time checks (active conversation, storytelling, sensitive content, grace period)
2. Question-specific checks (already answered, asked too many times)
3. Coaching signals (hold back / jump in)
4. Standard rate limits (frequency, cooldown, silence threshold)

**Responding to @Mentions:**

Receives a raw answer from the Historian, detects the question's language, applies warmth and personality, and sends in the question's language.

**Database Access:**

- **Read:** questions, facilitator_rules, real_time_levers, messages
- **Write:** event_log (decisions only)

**Common Mistakes:**

- Interrupting active conversations
- Asking questions without warmth formula
- Ignoring coaching signals
- Processing message content (Scribe's job)

---

### Historian (Default: "Clio")

**Role:** Answer questions about collected family history (does NOT send directly)

**Internal Name:** `BotRole.HISTORIAN`

**Question Types:**

| Type         | Example                                | Primary Tables        |
| ------------ | -------------------------------------- | --------------------- |
| person_info  | "Tell me about grandpa Abraham"        | people, claims        |
| relationship | "How is Maria related to Roberto?"     | relationships, people |
| timeline     | "When did the family come to America?" | events, claims        |
| location     | "Where did grandma grow up?"           | places, claims        |
| event        | "What happened at the 1962 wedding?"   | events, claims        |
| story        | "What's the story about the store?"    | stories, claims       |
| verification | "Is it true that...?"                  | claims                |

**Handling Conflicts:**

```typescript
// Present both versions without resolving
"There are different accounts in the family:
• According to Aunt Maria, grandma was born in 1928
• Uncle David mentioned it was 1930

Both memories are valuable parts of the family story."
```

**Output:** Returns `HistorianReply` to Facilitator (never sends directly)

**Database Access:**

- **Read:** people, claims, relationships, events, stories, places, images
- **Write:** event_log (question_answered)

**Common Mistakes:**

- Inventing facts not in the database
- Resolving conflicting claims
- Cold, encyclopedic responses
- Ignoring source attribution

---

### Admin (Default: "La Directora")

**Role:** Project manager - celebrate milestones, mediate conflicts, coach system

**Internal Name:** `BotRole.ADMIN`

**Celebration Structure:**

```
1. Exciting opening: "🎉 [Milestone]!"
2. Specific metrics: "X stories, Y timespan, Z contributors"
3. Emotional statement: "This is OUR family coming to life"
4. Name contributors: "Special thanks to Uncle David..."
5. Forward momentum: "Who's ready to keep going?"
```

**Conflict Mediation Framework:**

```
1. Validate BOTH sides: "Both memories are valuable"
2. Reframe as richness: "Different perspectives show full picture"
3. NEVER take sides
4. Redirect to shared values: "We all care about this"
5. De-escalate if needed: "Let's take a breath"
```

**Coaching Module:**

Monitors Facilitator performance (ignore rate, response rate) and adjusts behavior:

- Too aggressive → hold_back signal, reduce frequency
- Good engagement → jump_in signal, increase frequency
- Rate-limited: max 1 rule change/day, no reversals within 48 hours

**Database Access:**

- **Read:** All tables (needs complete system view)
- **Write:** facilitator_rules, real_time_levers, event_log

**Common Mistakes:**

- Taking sides in conflicts
- Cold/administrative tone
- Making too many rule changes too quickly

---

### Scribe (Default: "Don Rubén")

**Role:** Silent data extractor

**Internal Name:** `BotRole.SCRIBE`

**Responsibilities:**

1. Entity extraction (people, places, dates, events)
2. Story identification
3. Relationship mapping
4. Claim extraction with provenance
5. Pronoun resolution and interpretation tracking
6. Language detection
7. Cultural term preservation

**Extraction Philosophy:**

The Scribe extracts freely from the current message even if similar entities appear in context. It does not try to suppress duplicates — deduplication is deterministic code in the Registrar, not LLM reasoning. The Scribe only avoids re-extracting _claims_ from context messages (already processed).

**Output:** Domain model (see `ScribeDomainModel` type) passed to Registrar. The Scribe never writes to the database.

**Common Mistakes:**

- Writing directly to database
- Auto-resolving conflicts
- Translating cultural terms
- Trying to suppress extraction for dedup (Registrar's job)

---

### Curator (Hidden)

**Role:** Async image analyzer - OCR, era estimation, photo identification

**Internal Name:** `BotRole.CURATOR`

**Outputs:** Image analysis (description, people count, era estimate, OCR text), potential connections to existing stories, and proposed identification questions.

**Processing:**

- Async (doesn't block text processing)
- Uses Claude vision API
- Cross-references with existing stories

**Database Access:**

- **Read:** messages, people, stories, events, images
- **Write:** None (outputs to Registrar)

**Common Mistakes:**

- Blocking text processing
- Missing OCR opportunities
- Not cross-referencing stories

---

### Intern (Preprocessing)

**Role:** Lightweight preprocessing using Haiku for fast, low-cost operations

**Internal Name:** `BotRole.INTERN`

**Functions:**

- **Filter** - Determines if message is relevant for Scribe
- **Image Link** - Detects when text references recently shared images
- **Route** - Directs @mentions to Historian vs Admin

**Image Reference Types:**

- `describes` - Text describes what's in the image
- `identifies_people` - Text identifies people in the image
- `provides_context` - Text provides context (date, location, event)
- `asks_about` - Text asks a question about the image

**Routing Logic:**

```typescript
if (isBotMentioned(message) && isQuestion(message)) {
  return { action: 'historian' };
}
if (isBotMentioned(message)) {
  return { action: 'admin', adminSubtype: 'mention' };
}
if (isRelevantContent(message)) {
  return { action: 'scribe' };
}
return { action: 'ignore', reason: 'noise' };
```

**Database Access:**

- **Read:** conversation_events, images (recent)
- **Write:** event_log (filter/link decisions)

---

### Registrar (Backend)

**Role:** Database gatekeeper - ONLY component that writes to core tables

**Internal Name:** `BotRole.REGISTRAR`

**Responsibilities:**

1. Schema mapping (domain model → database)
2. Entity deduplication (people, places, events, stories, relationships, claims)
3. Claim creation (store as claims, not facts)
4. Conflict preservation (link conflicting claims)
5. Provenance tracking (link to source messages via join tables)

**Deduplication:**

Every entity type has its own dedup strategy — people use fuzzy name matching, places use exact name matching, events and stories use word-overlap similarity scoring, relationships use bidirectional lookup, and claims use duplicate + conflict detection.

When a story or event matches an existing record, the Registrar appends new content and links any new people/places rather than creating a duplicate.

**Deduplication Hard Rule:**
Deduplication applies only to entity identity (same person/place/event/story represented multiple ways). It must NEVER merge, delete, or "choose" between competing claims. Conflicting claims are preserved and linked.

**Database Access:**

- **Read:** All tables (for deduplication checks)
- **Write:** All core tables (EXCLUSIVE access)

**Common Mistakes:**

- Allowing other components to write
- Auto-resolving conflicts
- Missing provenance
- Weak deduplication

---

## Decision Hierarchy

### Static Configuration (Set by User)

```
config.bots.facilitator.personality
  → Initial values for formality, verbosity, engagement
```

### Dynamic Rules (Adjusted by Coach)

```
facilitator_rules table
  → max_questions_per_window, minimum_wait_after_question, current_signal
```

### Real-Time Levers (Immediate)

```
real_time_levers table
  → active_conversation_cooldown, sensitive_topic_cooldown, emotional_keywords
```

**Flow:** Static config → Dynamic rules → Real-time levers → Facilitator decision

---

## Database Access Pattern

All access scoped by family_id

| Agent           | Reads                                          | Writes                                             |
| --------------- | ---------------------------------------------- | -------------------------------------------------- |
| **Facilitator** | questions, rules, levers, messages             | event_log (decisions only)                         |
| **Historian**   | people, claims, relationships, events, stories | event_log (question_answered)                      |
| **Admin**       | All tables                                     | facilitator_rules, real_time_levers, event_log     |
| **Intern**      | conversation_events, images                    | event_log (filter/link decisions)                  |
| **Scribe**      | messages, people, places                       | None (outputs domain model)                        |
| **Curator**     | messages, images, stories                      | None (outputs to Registrar)                        |
| **Registrar**   | All tables (for deduplication)                 | people, places, events, stories, claims, questions |

**Key:** Only Registrar modifies core tables. Agents output domain models or signals.

---

## Key Design Principles

1. **Warmth is Non-Negotiable** - Every question uses the 4-part formula
2. **Claims Over Facts** - Everything is a claim with a source
3. **Preserve Conflicts** - Different memories honored, never auto-resolved
4. **Single Writer Pattern** - Only Registrar modifies core tables
5. **Sequential Processing** - One message at a time, in order
6. **Adaptive Behavior** - System learns from family response patterns
7. **Complete Audit Trail** - Every decision logged in event_log

---

## Configuration

All agents respect configuration from `project_config` table or config file:

```typescript
interface SobremesaConfig {
  projectName: string;
  languages: { primary: string; secondary: string[] };
  bots: {
    facilitator: { displayName: string; personality: {...} };
    admin: { displayName: string; personality: {...} };
    historian: { displayName: string; personality: {...} };
  };
  culturalTerms: string[];
}
```

**Internal code uses:** `BotRole.FACILITATOR`, `BotRole.ADMIN`, etc.
**Configuration provides:** Display names, personality traits, cultural adaptation

---

## Implementation Libraries

```
libs/agents/
├── facilitator/    ← Question asking + response formatting
├── historian/      ← Database querying + answer synthesis
├── admin/          ← Celebrations, mediation, coaching
├── scribe/         ← Entity extraction + claim creation
├── curator/        ← Image analysis
├── intern/         ← Filtering, routing, image linking
└── registrar/      ← Database persistence (no LLM)
```

**Model Allocation:**

- **Intern** uses Claude Haiku for fast, low-cost preprocessing
- **Facilitator, Historian, Scribe, Curator, Admin** use Claude Sonnet
- **Registrar** requires no LLM (pure TypeScript logic)

---

## Related Documentation

- **[WARMTH.md](../docs/WARMTH.md)** - Core philosophy behind the warmth formula
- **[ARCHITECTURE.md](ARCHITECTURE.md)** - System design and data flow
- **[CONFIGURATION.md](../docs/CONFIGURATION.md)** - How to configure for your family
- **[ADRs](adr/)** - Architecture decision records

---

**Remember:** Warmth = Data Quality. The agents are not just processing data - they're creating a safe space for families to share precious memories.
