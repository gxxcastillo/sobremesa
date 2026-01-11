# Implementation Plan

Minimal checklist to guide development. Details emerge during build.

---

## Phase 1: Foundation (Week 1)

**Goal:** Basic infrastructure working end-to-end.

### Database Setup
- [ ] Run SCHEMA.sql on Supabase
- [ ] Verify all tables created
- [ ] Test helper views work
- [ ] Confirm initial data inserted (facilitator_rules, real_time_levers)

### Chat Provider Connection
- [ ] Create Chat Provider bot (BotFather)
- [ ] Connect to Chat Provider Bot API
- [ ] Receive messages in group chat
- [ ] Store messages in database (messages table)
- [ ] Test bilingual detection (es/en/mixed)

### Queue System
- [ ] Ordered message queue (Redis or in-memory for POC)
- [ ] FIFO processing (one message at a time)
- [ ] Retry logic (basic)
- [ ] Queue monitoring (simple logging)

**Success Criteria:**
- Message arrives in Chat Provider → Stored in DB → Shows in queue → Processed sequentially

---

## Phase 2: Core Extraction (Week 2)

**Goal:** Scribe extracts data, Registrar saves it.

### Text Scribe
- [ ] Process message from queue
- [ ] Extract entities (people, places, events)
- [ ] Generate bilingual content (original + translations)
- [ ] Detect language (es/en/mixed)
- [ ] Preserve cultural terms (from config)
- [ ] Output domain model (NOT database writes)
- [ ] Basic context loading (5 full messages, 15 summaries)

### Registrar
- [ ] Receive domain model from Scribe
- [ ] Map to database schema
- [ ] Deduplicate people (fuzzy matching on name + aliases)
- [ ] Insert/update people, places, events, stories
- [ ] Create claims (NEW approach - provenance for facts)
- [ ] Link to source messages
- [ ] Generate content hashes

### Claims Table Population
- [ ] Every fact becomes a claim with source
- [ ] Confidence levels assigned
- [ ] Conflicts detected but NOT resolved
- [ ] Link conflicting claims together

**Success Criteria:**
- Message processed → Entities extracted → Claims created → Data in database with provenance

---

## Phase 3: Question System (Week 3)

**Goal:** Scribe generates questions, Facilitator asks them warmly.

### Question Generation (Scribe)
- [ ] Detect gaps in stories
- [ ] Generate questions about missing details
- [ ] Assign priorities
- [ ] Store in questions table
- [ ] Detect answers to pending questions

### Facilitator Bot
- [ ] Read pending questions from queue
- [ ] Check facilitator_rules (dynamic)
- [ ] Check real_time_levers (immediate checks)
- [ ] Apply warmth formula: [Warmth] + [Question] + [Permission] + [Gratitude]
- [ ] Log decision (asked/didn't ask + reason)
- [ ] Track activity (timestamps, message counts)
- [ ] Update question status

### Real-Time Decision Logic
- [ ] Active conversation detection (3+ people in 10 min)
- [ ] Storytelling detection (same person, multiple messages)
- [ ] Sensitive content detection (emotional keywords)
- [ ] Grace period (wait 3 min in case still typing)
- [ ] Already answered check (scan recent context)
- [ ] Question retirement (after max repeats)

**Success Criteria:**
- Scribe generates question → Facilitator checks all levers → Asks warmly (or waits) → Logs decision

---

## Phase 4: Coaching & Optimization (Week 4)

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
  - [ ] Frequent interruptions → increase cooldown
  - [ ] Questions being retired → reduce max_repeats
  - [ ] Already answered frequently → increase context window
- [ ] Log lever adjustments

**Success Criteria:**
- Family ignoring questions → Coach detects → Reduces frequency → Questions stop being ignored
- Active conversations detected → Facilitator waits automatically

---

## Phase 5: Admin Functions (Week 5)

**Goal:** Admin manages project, celebrates, mediates.

### Milestone Celebrations
- [ ] Track story count, contributor count, timespan
- [ ] Detect milestones (10, 25, 50, 100 stories)
- [ ] Generate celebration messages
  - [ ] Exciting opening
  - [ ] Specific metrics
  - [ ] Emotional statement
  - [ ] Name contributors
  - [ ] Forward momentum
- [ ] Check for recent sensitive content (don't celebrate immediately after grief)

### Conflict Mediation
- [ ] Monitor for conflicting claims
- [ ] Validate BOTH sides
- [ ] Reframe as richness (not problem)
- [ ] NEVER take sides
- [ ] Post mediation message when conflict detected

### Welcome & Re-engagement
- [ ] Welcome new members to group
- [ ] Detect prolonged silence (> max_silence threshold)
- [ ] Send warm re-engagement message

**Success Criteria:**
- 25 stories collected → Admin celebrates warmly and specifically
- Conflict detected → Admin mediates without taking sides
- Week of silence → Admin re-engages gently

---

## Phase 6: Polish & Additional Features (Week 6+)

**Goal:** Round out the experience.

### Bilingual Translation
- [ ] Integrate translation API (if not done earlier)
- [ ] Generate content_es and content_en for all content
- [ ] Preserve cultural terms (never translate)
- [ ] Add explanations in parentheses

### Curator (Async)
- [ ] Detect images in messages
- [ ] Delegate to Curator (background job)
- [ ] Analyze photos (Claude vision API)
- [ ] OCR text extraction
- [ ] Cross-reference with existing stories
- [ ] Generate questions about photos
- [ ] Don't block text processing

### Web3 Integration (Optional)
- [ ] Generate content hashes for claims
- [ ] Write to Solana (if web3Enabled in config)
- [ ] Store transaction hashes
- [ ] Non-blocking (async)

### Configuration Loading
- [ ] Load from project_config table or file
- [ ] Apply bot names from config
- [ ] Apply personality traits from config
- [ ] Apply cultural terms from config

**Success Criteria:**
- All text bilingual (original + translations)
- Photos analyzed and questions generated
- Web3 hashes written (if enabled)
- Configuration fully drives behavior

---

## Testing Strategy

### Unit Tests
- Domain model extraction (Scribe)
- Warmth formula application (Facilitator)
- Deduplication logic (Registrar)
- Conflict detection (Claims)

### Integration Tests
- Message → Queue → Scribe → Registrar → Database
- Question generation → Facilitator → Chat Provider → Answer detection
- Coaching adjustment → Rule change → Facilitator behavior change

### Manual Testing
- Real Chat Provider group
- Small test family (3-5 people)
- Multiple languages
- Edge cases (conflicts, sensitive content, silence)

---

## Demo Flow (For Testing)

**Message 1 (Uncle David):**
```
"My grandfather Abraham came to America from Warsaw in the late 1880s.
He ran a shop on Nalewki Street before leaving."
```

**Expected:**
- Entities extracted: Abraham (person), Warsaw (place), Nalewki Street (place), shop (event)
- Claims created: arrival date (1880s, low precision), shop location (high confidence)
- Story created: "Abraham's shop in Warsaw"
- Questions generated: "What kind of shop?", "What year exactly?"

**Message 2 (Facilitator):**
```
"Uncle David, this story about Abraham's shop is wonderful. If you happen
to remember, what kind of goods did he sell? No pressure if you don't
recall the details. Thank you for sharing!"
```

**Expected:**
- Warmth formula applied correctly
- Logged in event_log
- Question marked as "asked"

**Message 3 (Uncle David):**
```
"I think it was a general store, sold food and household items."
```

**Expected:**
- Answer detected by Scribe
- Question marked as "answered"
- New claim created: shop type = general store

**Message 4 (Aunt Sarah):**
```
"No, it was specifically a bakery. I remember my mother talking about
the bread."
```

**Expected:**
- Conflict detected (general store vs bakery)
- Both claims preserved
- Claims linked as conflicting
- Admin mediates: "Both memories are valuable..."

---

## MVP Milestone

**Definition of Done for POC:**
1. ✅ Messages flow: Chat Provider → Queue → Scribe → Registrar → DB
2. ✅ Questions generated and asked warmly
3. ✅ Answers detected and recorded
4. ✅ Claims created with provenance
5. ✅ Conflicts preserved (not auto-resolved)
6. ✅ Coaching adjusts facilitator behavior
7. ✅ Celebrations work
8. ✅ Bilingual storage working
9. ✅ Event log captures everything
10. ✅ Configuration drives behavior

**MVP Timeline:** 6 weeks for full POC

**Post-MVP:**
- Dashboard UI (view stories, timeline, conflicts)
- Advanced analytics
- Knowledge graph visualization
- Additional language support
- WhatsApp integration

---

## Key Implementation Principles

1. **Start Simple** - Get basic flow working first
2. **Test Constantly** - Real Chat Provider group early
3. **Warmth First** - Every message checked for warmth
4. **Iterate Fast** - POC over perfection
5. **Log Everything** - Event log from day one
6. **Follow Architecture** - Trust the decisions we made

---

**This is a guide, not a prescription.** Claude Code will make tactical decisions during build. The architecture docs provide the strategic direction.

Good luck building! 🎉
