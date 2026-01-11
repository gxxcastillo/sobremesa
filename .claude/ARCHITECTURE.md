# System Architecture

## Quick Reference

**Core Roles (Internal Names):**
- `BotRole.FACILITATOR` - Asks questions
- `BotRole.ADMIN` - Manages project
- `BotRole.SCRIBE` - Extracts data
- `BotRole.CURATOR` - Analyzes photos (hidden)
- `BotRole.REGISTRAR` - Persists data to database (hidden) 

**Default Names For "Public" Agents (Configurable):**
- Facilitator: "Carmencita"
- Admin: "La Directora"  
- Scribe: "Don Rubén"

---

## Data Flow

Every row that represents family data MUST be scoped by family_id.
Every query MUST filter by family_id.
Deduplication MUST be done within family_id only.

family_id is the primary isolation boundary of the system.

```
Chat Message
      │
      ├──→ Queue → Events Table → Scribe → Registrar → Database (Claims Table)
      │
      └──→ Live Stream
           ├──→ Admin (contains internal coaching module, celebrations, mediation)
           └──→ Facilitator (activity tracking)
                    ↑
                    │
              Coaching Module 
              (monitors & adjusts in real-time)
```

Ordering rule: Text messages are processed sequentially and in order (context-sensitive). Media enrichments (Curator outputs) are asynchronous and may arrive later; when they do, they generate additional domain-model outputs and questions without reordering the text stream.

---

## Sequence Diagram

``` mermaid
sequenceDiagram
  autonumber
  participant User as Family Member
  participant Chat as Chat Provider
  participant DB as Database
  participant Q as Ordered Queue
  participant S as Scribe (BotRole.SCRIBE)
  participant C as Curator (BotRole.CURATOR)
  participant R as Registrar (Single Writer)
  participant F as Facilitator (BotRole.FACILITATOR)
  participant A as Admin (BotRole.ADMIN)

  User->>Chat: Sends message (text and/or media)
  Chat->>DB: Store raw message (messages)
  DB->>Q: Enqueue message_id (ordered, per family_id)

  Q->>S: Dequeue next message_id (sequential)
  S->>DB: Load context (recent msgs, pending questions, entities)

  alt Text content
    S->>S: Extract entities/stories/claims<br/>Generate proposed questions<br/>Detect answered questions
    S-->>R: Domain model (text)
  end

  alt Media attachment present
    S->>C: Dispatch media job (async, non-blocking)
  end

  R->>DB: Write entities/stories/claims (single writer)
  R->>DB: Write questions + question status updates
  R->>DB: Write conflict links (preserve conflicts)
  R->>DB: Append event_log entries (audit)

  par Facilitator decision loop
    F->>DB: Read pending questions + rules + real-time levers
    F->>F: Decide ask vs wait (real-time → coaching → rate limits)
    alt Ask now
      F->>Chat: Ask warm question (4-part formula)
      F->>DB: Log decision + mark question asked (via Registrar or allowed narrow write)
    else Wait
      F->>DB: Log decision (reason)
    end
  and Admin coaching loop (periodic)
    A->>DB: Read performance + event_log + conflicts
    A->>DB: Adjust facilitator_rules / real_time_levers (rate-limited)
    A->>Chat: Celebrate / mediate / re-engage as needed
  end

  C-->>R: Media domain model + photo questions (async completion)
  R->>DB: Persist media-derived claims/images/questions (single writer)
```

## Key Architectural Decisions

### 1. Configurable Library (Not Single-Family App)
- Internal: Generic role names (`BotRole.FACILITATOR`)
- Configuration: Display names ("Carmencita", "Annie", "Yui")
- Reusable across cultures and languages

### 2. Bilingual+ Storage
Every text stored in 3 forms:
- `content_original` - Exact words (sacred)
- `content_{primary}` - Primary language version
- `content_{secondary}` - Secondary language version

### 3. Claims-Based Data Model
Instead of storing facts directly, store **claims**:
```sql
CREATE TABLE claims (
  id UUID,
  claim_type VARCHAR(50),
  subject VARCHAR(255),
  claim_value JSONB,
  source_message_id UUID,
  claimed_by VARCHAR(255),
  confidence VARCHAR(20),
  conflicts_with UUID[],
  status VARCHAR(20)
);
```

Benefits:
- Clear provenance
- Easy conflict detection
- Multiple claims about same thing
- Audit trail

### 4. Coaching Module with Real-Time Levers

**Two-tier control system:**

**Static Rules (User Config):**
- Bot personalities
- Initial engagement phase

**Dynamic Rules (Coach Adjusts):**
- Question frequency (1-5 per window)
- Wait times (12-72 hours)
- Coaching signals (hold_back/neutral/jump_in)

**Real-Time Levers (Immediate Response):**
- `activeConversationCooldown` - Prevent interruptions
- `sensitiveTopicCooldown` - Space after grief/trauma
- `emotionalKeywords` - Trigger detection
- `contextCheckMessageCount` - How much to review
- `skipIfAnsweredRecently` - Avoid redundancy

### 5. Single Writer Pattern
ONLY Registrar modifies core tables:
- Prevents race conditions
- Ensures data integrity
- Clear audit trail
- Transaction management

### 6. Web3 Integration Hook
Optional Solana integration:
- Write content hashes to blockchain
- Tamper-proof audit trail
- Verify data integrity
- Configurable (on/off)

### 7. Event Log
Complete audit trail:
```sql
CREATE TABLE event_log (
  id UUID,
  timestamp TIMESTAMP,
  event_type VARCHAR(50),
  actor VARCHAR(255),
  event_data JSONB
);
```

### 8. Redaction System
- Soft delete (mark as redacted, keep for audit)
- Hard delete (GDPR compliance)
- Cascade to derived claims
- Blockchain redaction record

---

## Database Schema (High-Level)

**Core Tables:**
- `conversation_events` - Raw message ingestion (provider-agnostic)
- `claims` - All factual claims with sources
- `people` - Family members
- `places` - Locations
- `events` - Timeline events
- `stories` - Narrative fragments
- `images` - Media catalog
- `questions` - Question lifecycle

**System Tables:**
- `facilitator_rules` - Dynamic engagement rules
- `event_log` - Complete audit trail
- `project_config` - Configuration storage

**All content tables have:**
- `content_original`, `language_original`
- `content_{primary}`, `content_{secondary}`
- `source_message_id`, `created_by`
- `confidence`, `timestamp`
- `redacted`, `redacted_at`, `redaction_reason`
- `content_hash`, `solana_tx_hash` (if web3 enabled)

**Multi-family scoping** 
All persisted data and all agent reads/writes are scoped by family_id. Every queue item, message, claim, question, and event_log entry must include family_id, and every query must filter by it.

---

## Component Details

Questions are proposed by Scribe/Curator, asked by Facilitator, answered-detected by Scribe, and persisted by Registrar.

See AGENTS.md for complete specifications.

### Facilitator
- Asks questions using warmth formula
- Checks real-time levers before asking
- Respects coaching signals
- Tracks activity (not content)

### Admin
- Celebrates milestones
- Mediates conflicts (validates both sides)
- Runs coaching module
- Manages system health

### Scribe
- Extracts entities, relationships, events
- Generates questions about gaps
- Detects answers to pending questions
- Flags conflicts (never resolves)
- Outputs domain model (not DB schema)

### Registrar
- Maps domain model to database
- Deduplicates entities
- Creates claims (not facts)
- Preserves conflicts
- Optional web3 writes

### Coaching Module
- Monitors facilitator performance
- Adjusts engagement rules dynamically
- Sends real-time signals
- Rate-limited changes (prevent oscillation)

---

## Configuration Layers

See CONFIGURATION.md for complete guide.

**Layer 1: Identity**
- Project name
- Languages
- Bot names

**Layer 2: Personality**
- Formality, verbosity, emoji
- Engagement style
- Authority level

**Layer 3: Technical**
- Performance thresholds
- Rate limits
- Context windows

---

## Key Principles

1. **Warmth First** - Foundation of success
2. **Configurable** - Works for any family
3. **Bilingual+** - 2+ languages supported
4. **Claims-Based** - Provenance for everything
5. **Conflict Preservation** - Never auto-resolve
6. **Adaptive** - System learns and optimizes
7. **Auditable** - Complete event log
8. **Privacy-Respecting** - Redaction capability

---

See other documentation files for details:
- CONFIGURATION.md - How to configure
- AGENTS.md - Agent specifications
- IMPLEMENTATION.md - Build plan
- DECISIONS.md - Why we made these choices
