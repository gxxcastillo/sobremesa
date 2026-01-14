# Implementation Plan

Progress tracker for Sobremesa development.

---

## Current Status

**Last Updated:** January 2026

| Phase                            | Status      | Notes                                              |
| -------------------------------- | ----------- | -------------------------------------------------- |
| Phase 1: Foundation              | COMPLETE    | Telegram bots, Supabase, message ingestion         |
| Phase 2: Core Extraction         | COMPLETE    | Scribe extracts entities, Registrar persists       |
| Phase 3: Question System         | COMPLETE    | Warm questions, Facilitator asks, answer detection |
| Phase 4: Coaching & Optimization | NOT STARTED | Adaptive behavior based on response patterns       |
| Phase 5: Admin Functions         | NOT STARTED | Celebrations, conflict mediation                   |
| Phase 6: Polish                  | NOT STARTED | Curator, Web3, translations                        |

---

## Phase 1: Foundation - COMPLETE

**Goal:** Basic infrastructure working end-to-end.

### Database Setup

- [x] Create Supabase project
- [x] Run SCHEMA.sql
- [x] Verify all tables created
- [x] Test connection from Node.js

### Telegram Bot Connection

- [x] Create bots via BotFather (Scribe, Facilitator, Admin)
- [x] Connect to Telegram Bot API via Telegraf
- [x] Receive messages in group chat
- [x] Store messages in `conversation_events` table
- [x] Handle text, photo, document messages

### Queue System

- [x] `processing_queue` table with optimistic locking
- [x] FIFO processing (one message at a time)
- [x] Retry logic with exponential backoff
- [x] Queue monitoring via event_log

### Family Registration

- [x] `/register` command to link chat to family
- [x] Dynamic family lookup by chat ID
- [x] Multi-family support (family_id scoping)

**Verification:**

```bash
nx serve chatbots
# Send message in Telegram group
# Check: conversation_events table has new row
# Check: processing_queue has item
# Check: event_log shows ingestion
```

---

## Phase 2: Core Extraction - COMPLETE

**Goal:** Scribe extracts data, Registrar saves it.

### Scribe Agent

- [x] Process message from queue
- [x] Call Claude API with extraction prompt
- [x] Extract entities: people, places, events, relationships
- [x] Extract stories (narrative fragments)
- [x] Detect language (en/es/mixed)
- [x] Output domain model (ScribeDomainModel type)
- [x] Context loading (recent messages + family data)

### Registrar Agent

- [x] Receive domain model from Scribe
- [x] Map to database schema
- [x] Deduplicate people (name matching)
- [x] Insert/update people, places, events, stories
- [x] Create claims with provenance
- [x] Link to source messages
- [x] Handle relationships

### Libraries Created

- `libs/agents/scribe` - Scribe agent with prompt builder
- `libs/agents/registrar` - Registrar with repository access
- `libs/queue` - MessageQueue + MessageProcessor
- `libs/database` - All repositories

**Verification:**

```bash
npx tsx scripts/test-scribe.ts
# Check: ScribeDomainModel output with people, places, events
npx tsx scripts/summary.ts
# Check: Data populated in database
```

---

## Phase 3: Question System - COMPLETE

**Goal:** Scribe generates questions, Facilitator asks them warmly.

### Question Generation (Scribe)

- [x] Detect gaps in stories (who, what, when, where, why)
- [x] Generate warm questions (not interrogative)
- [x] Assign priorities (0-100 scale)
- [x] Store in questions table with status='proposed'
- [x] Include targeting (target_person, target_event, target_place)

### Facilitator Agent

- [x] Read pending questions by priority
- [x] Rate limiting (min minutes between questions per family)
- [x] Send via Facilitator bot
- [x] Mark question as 'asked'
- [x] Store external message ID for answer detection
- [x] Log decisions in event_log

### Answer Detection

- [x] Track external message ID when Facilitator sends question
- [x] Detect replies (via externalReplyToId)
- [x] Match reply to original question
- [x] Mark question as 'answered'
- [x] Link answer message to question

### Libraries Created

- `libs/agents/facilitator` - FacilitatorAgent

**Verification:**

```bash
npx tsx scripts/test-facilitator.ts
# Check: Question asked with mock sender
npx tsx scripts/test-send-question.ts
# Check: Real message sent to Telegram
npx tsx scripts/test-answer-detection.ts
# Check: Questions with external IDs, answer events
```

---

## Phase 4: Coaching & Optimization - NOT STARTED

**Goal:** System adapts to family response patterns.

### Coaching Module (in Admin)

- [ ] Monitor facilitator performance
  - [ ] Track ignore rate (questions not answered)
  - [ ] Track response rate (questions answered)
  - [ ] Track timing patterns
- [ ] Adjust dynamic rules when thresholds hit
  - [ ] If ignore rate > 50% → hold_back signal, reduce frequency
  - [ ] If response rate > 70% → jump_in signal, increase frequency
- [ ] Respect rate limits
  - [ ] Max 1 rule change per day
  - [ ] No reversals within 48 hours
- [ ] Log all adjustments in event_log

### Real-Time Flow Monitoring

- [ ] Monitor event_log for patterns
- [ ] Adjust real-time levers when issues detected
- [ ] Log lever adjustments

---

## Phase 5: Admin Functions - NOT STARTED

**Goal:** Admin manages project, celebrates, mediates.

### Milestone Celebrations

- [ ] Track story count, contributor count
- [ ] Detect milestones (10, 25, 50, 100 stories)
- [ ] Generate celebration messages
- [ ] Check for recent sensitive content

### Conflict Mediation

- [ ] Monitor for conflicting claims
- [ ] Validate BOTH sides
- [ ] Reframe as richness (not problem)
- [ ] NEVER take sides

### Welcome & Re-engagement

- [ ] Welcome new members to group
- [ ] Detect prolonged silence
- [ ] Send warm re-engagement message

---

## Phase 6: Polish & Additional Features - NOT STARTED

**Goal:** Round out the experience.

### Curator (Async Image Analysis)

- [ ] Detect images in messages
- [ ] Analyze photos (Claude vision API)
- [ ] OCR text extraction
- [ ] Cross-reference with existing stories
- [ ] Generate questions about photos

### Web3 Integration (Optional)

- [ ] Generate content hashes for claims
- [ ] Write to Solana (if enabled)
- [ ] Store transaction hashes

### Bilingual Translation

- [ ] Integrate translation API
- [ ] Generate translations for all content
- [ ] Preserve cultural terms

---

## Scripts Reference

| Script                             | Purpose                            |
| ---------------------------------- | ---------------------------------- |
| `scripts/summary.ts`               | Show what we know about the family |
| `scripts/test-scribe.ts`           | Test Scribe extraction             |
| `scripts/test-facilitator.ts`      | Test Facilitator with mock sender  |
| `scripts/test-send-question.ts`    | Send real question via Telegram    |
| `scripts/test-answer-detection.ts` | Check answer detection status      |
| `scripts/debug-facilitator.ts`     | Debug Facilitator issues           |

---

## Library Structure

```
apps/
  chatbots/     # Main application

libs/
  agents/
    scribe/                 # Text extraction agent
    registrar/              # Database persistence agent
    facilitator/            # Question-asking agent
  database/                 # Supabase client + repositories
  queue/                    # Message queue + processor
  telegram/                 # Bot manager + handlers
  shared/
    types/                  # Domain types
    utils/                  # Shared utilities
```

---

## Environment Variables

Required in `.env`:

```bash
# Supabase
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# Claude API
ANTHROPIC_API_KEY=sk-ant-...

# Telegram Bots
TELEGRAM_BOT_TOKEN_SCRIBE=123456:ABC...
TELEGRAM_BOT_TOKEN_FACILITATOR=123456:DEF...
TELEGRAM_BOT_TOKEN_ADMIN=123456:GHI...  # Optional
```

---

## Running the System

```bash
# Start the conversation gateway
nx serve chatbots

# In another terminal, monitor logs
tail -f .nx/workspace-data/*.log

# Test scripts
npx tsx scripts/summary.ts
```

---

## What's Working Now

1. **Message Flow:** Telegram → Queue → Scribe → Registrar → Database
2. **Extraction:** People, places, events, relationships, stories
3. **Question Generation:** Warm questions with priorities and targeting
4. **Question Asking:** Facilitator sends questions with rate limiting
5. **Answer Detection:** Replies to questions detected and linked
6. **Summary:** View what we know with `scripts/summary.ts`

---

## Next Steps

When ready to continue:

1. **Phase 4** - Add coaching to optimize question frequency
2. **Phase 5** - Add celebrations and conflict mediation
3. **Phase 6** - Add image analysis and optional Web3
