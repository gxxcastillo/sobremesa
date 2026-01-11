# Sobremesa Agents

High-level overview of the AI agents that power Sobremesa's family history collection system.

For detailed specifications, see individual agent files in this directory.

---

## The Five Agents

| Agent | Role | Visible? | Calls Claude API? | Prompt File |
|-------|------|----------|-------------------|-------------|
| **Facilitator** | Asks warm questions | ✅ Yes | ✅ Yes | `prompts/facilitator.md` |
| **Admin** | Celebrates & mediates | ✅ Yes | ✅ Yes | `prompts/admin.md` |
| **Scribe** | Extracts data | ❌ No | ✅ Yes | `prompts/scribe.md` |
| **Curator** | Analyzes photos | ❌ No | ✅ Yes | `prompts/curator.md` |
| **Registrar** | Saves to database | ❌ No | ❌ No | None (pure logic) |

---

## Quick Overview

### 👥 Facilitator (Carmencita)

**What:** Asks warm, thoughtful questions to fill gaps in stories  
**When:** After Scribe detects missing information  
**How:** Uses 4-part warmth formula: [Warmth] + [Question] + [Permission] + [Gratitude]

**Key Decisions:**
- Should I ask this question now? (10-step decision logic)
- Is the conversation active? (real-time flow detection)
- Is this too soon after sensitive content?
- Has this been answered already?

**See:** [`.claude/AGENT_FACILITATOR.md`](AGENT_FACILITATOR.md) for complete specification

---

### 🔧 Admin (La Directora)

**What:** Project manager - celebrates milestones, mediates conflicts, coaches system  
**When:** Milestones reached, conflicts detected, silence too long  
**How:** 5-part celebration structure, conflict mediation framework, coaching signals

**Key Responsibilities:**
- **Celebrate** - 10, 25, 50, 100 story milestones
- **Mediate** - Handle conflicting claims (never take sides)
- **Re-engage** - Gently prompt after prolonged silence
- **Coach** - Adjust facilitator behavior based on family response

**See:** [`.claude/AGENT_ADMIN.md`](AGENT_ADMIN.md) for complete specification

---

### 📝 Scribe (Don Rubén)

**What:** Silent data extractor - processes messages, creates claims, generates questions  
**When:** Every message received  
**How:** Claude API processes message → outputs domain model → detects conflicts

**Key Outputs:**
- **Entities** - People, places, events, stories
- **Claims** - Every fact with source and confidence
- **Questions** - Generated from detected gaps
- **Conflicts** - Flagged but never resolved
- **Answers** - Detected from conversation

**See:** [`.claude/AGENT_SCRIBE.md`](AGENT_SCRIBE.md) for complete specification

---

### 🎨 Curator (Hidden)

**What:** Async image analyzer - OCR, era estimation, photo identification  
**When:** Image shared in conversation  
**How:** Claude vision API → analysis → questions for Facilitator

**Key Outputs:**
- Visual description (people, setting, objects)
- OCR text extraction (signs, handwriting)
- Era estimation (based on photo technology, clothing, etc.)
- Connections to existing stories
- Questions about the photo

**See:** [`.claude/AGENT_CURATOR.md`](AGENT_CURATOR.md) for complete specification

---

### 💾 Registrar (Backend)

**What:** Single database writer - receives domain models, saves to Supabase  
**When:** After Scribe or Curator completes processing  
**How:** Pure TypeScript logic (no AI)

**Key Functions:**
- **Map** - Domain model → database schema
- **Deduplicate** - Fuzzy match on names/aliases
- **Save** - Insert/update in Supabase
- **Link** - Connect claims to conflicts
- **Web3** - Optional Solana writes

**See:** [AGENT_REGISTRAR.md](AGENT_REGISTRAR.md) for complete specification

---

## System Flow

```
1. Message arrives in Chat Provider
   ↓
2. Stored in messages table
   ↓
3. Added to ordered queue
   ↓
4. Scribe processes (extracts entities, creates claims)
   ↓
5. Registrar saves (domain model → database)
   ↓
6. Facilitator checks if should ask question
   ├─ YES → Asks warmly using 4-part formula
   └─ NO → Waits (logs reason in event_log)
   ↓
7. Admin monitors and adjusts
   ├─ Celebrates milestones
   ├─ Mediates conflicts
   └─ Coaches Facilitator
```

## Question Lifecycle (Authoritative)

A “question” is a first-class object with its own lifecycle. Multiple agents participate, but only the Facilitator speaks to the family.

1) Propose (Scribe / Curator)
	•	Scribe proposes questions when it detects gaps in a story, and stores them in the questions table with priority + context.
	•	Curator proposes questions when an image/document is analyzed (identification, era, text, connections), also stored in questions.

2) Decide if/when to ask (Facilitator)
	•	Facilitator is the only agent allowed to ask questions in the group.
	•	It reads pending questions and applies: real-time levers → coaching signal → rate limits → timing rules.
	•	If it asks, it must use: [Warmth] + [Question] + [Permission] + [Gratitude].

3) Detect answers (Scribe)
	•	Scribe processes every new message and checks whether it answers any pending question(s).
	•	Answer detection produces a structured “answered” signal tied to the source message.

4) Persist state (Registrar)
	•	Registrar is the single writer that updates canonical persistence: question status changes (asked/answered/retired), links to messages, and any resulting claims/entities.

5) Adapt behavior (Admin)
	•	Admin monitors engagement outcomes (ignored vs answered) and adjusts facilitator_rules / real-time levers over time (rate-limited), never changing content or facts.

Key rule: Scribe/Curator propose questions, Facilitator asks, Scribe detects answers, Registrar writes state, Admin tunes behavior.

---

## Decision Hierarchy

### Static Configuration (Set by User)
```
config.bots.facilitator.personality
  ↓
Initial values for formality, verbosity, engagement, etc.
```

### Dynamic Rules (Adjusted by Coach)
```
facilitator_rules table
  ↓
max_questions_per_window: 2
minimum_wait_after_question: 24 hours
current_signal: "neutral"
```

### Real-Time Levers (Immediate)
```
real_time_levers table
  ↓
active_conversation_cooldown: 30 min
sensitive_topic_cooldown: 24 hours
emotional_keywords: ["died", "death", "war"...]
```

**Flow:** Static config → Dynamic rules → Real-time levers → Facilitator decision

---

## Key Design Principles

### 1. Warmth is Non-Negotiable
Every question MUST use the 4-part formula. No exceptions.

### 2. Claims Over Facts
Everything is a claim with a source. Provenance for everything.

### 3. Preserve Conflicts
Different memories are honored, never auto-resolved.

### 4. Single Writer Pattern
ONLY Registrar modifies core database tables.

### 5. Sequential Processing
One message at a time, in order. Context matters.

### 6. Adaptive Behavior
System learns and optimizes based on family response patterns.

### 7. Complete Audit Trail
Every decision logged in event_log.

---

## Database Access Pattern

All access scoped by family_id

| Agent | **Reads** | **Writes** |
|-------|-----------|------------|
| **Facilitator** | questions, facilitator_rules, real_time_levers, messages (activity) | event_log (decisions only) |
| **Admin** | All tables | facilitator_rules, real_time_levers, event_log |
| **Scribe** | messages, people, places, questions (to detect answers) | None (outputs domain model) |
| **Curator** | messages, images, stories (for connections) | None (outputs to Registrar) |
| **Registrar** | All tables (for deduplication) | people, places, events, stories, claims, questions, images |

**Key:** Only Registrar modifies core tables. Agents output domain models or signals.

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
    scribe: { displayName: string; personality: {...} };
  };
  culturalTerms: string[];
  // ... see CONFIGURATION.md for complete schema
}
```

**Internal code uses:** `BotRole.FACILITATOR`, `BotRole.ADMIN`, etc.  
**Configuration provides:** Display names, personality traits, cultural adaptation

---

## Coaching Loop

```
Admin monitors Facilitator performance
  ↓
Detects patterns (ignores, timing issues, etc.)
  ↓
Adjusts dynamic rules in facilitator_rules table
  ↓
Adjusts real-time levers if needed
  ↓
Logs changes in event_log
  ↓
Facilitator reads updated rules
  ↓
Behavior changes
  ↓
Repeat every 24 hours
```

**Rate limits:**
- Max 1 rule change per day
- No reversals within 48 hours
- Only adjust when thresholds hit

---

## For Detailed Specifications

Each agent has a complete specification document:

- **[Facilitator](.claude/AGENT_FACILITATOR.md)** - 10-step decision logic, warmth formula, real-time checks
- **[Admin](.claude/AGENT_ADMIN.md)** - Celebration structure, mediation framework, coaching module
- **[Scribe](.claude/AGENT_SCRIBE.md)** - Entity extraction, claim creation, conflict detection
- **[Curator](.claude/AGENT_CURATOR.md)** - Image analysis, OCR, question generation
- **[Registrar](.claude/AGENT_REGISTRAR.md)** - Schema mapping, deduplication, Web3 integration

---

## Implementation Libraries

In the Nx monorepo:

```
libs/agents/
├── facilitator/        ← Implements facilitator.md spec
├── admin/              ← Implements admin.md spec
├── scribe/         ← Implements scribe.md spec
└── curator/   ← Implements curator.md spec

libs/data-writer/       ← Implements data-writer.md spec (not an agent lib)
```

Each library loads its corresponding prompt from `prompts/` and implements the decision logic described in its spec.

---

## Related Documentation

- **[WARMTH.md](WARMTH.md)** - Core philosophy behind the warmth formula
- **[ARCHITECTURE.md](ARCHITECTURE.md)** - System design and data flow
- **[CONFIGURATION.md](CONFIGURATION.md)** - How to configure for your family
- **[DECISIONS.md](DECISIONS.md)** - Why we made these architectural choices

---

**Remember:** Warmth = Data Quality. The agents are not just processing data - they're creating a safe space for families to share precious memories.