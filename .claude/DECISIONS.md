# Architecture Decision Records

This document explains WHY we made key architectural decisions.

Format: ADR (Architecture Decision Record)
- **Date:** When decided
- **Status:** Accepted / Superseded
- **Context:** What problem we're solving
- **Decision:** What we chose
- **Consequences:** Trade-offs and implications

---

## ADR-001: Configurable Library (Not Single-Family App)

**Date:** 2026-01-10  
**Status:** Accepted

**Context:**  
Initial design was specific to one Nicaraguan family (Spanish/English, Carmencita, La Directora). Need to make reusable for ANY family.

**Decision:**  
Build as configurable library:
- Internal code uses generic role names (`BotRole.FACILITATOR`)
- Configuration provides display names ("Carmencita", "Annie", "Yui")
- All personality traits configurable
- Language support configurable (any primary + secondaries)

**Consequences:**
- **Positive:** Reusable product, can serve many families
- **Positive:** Forces clean architecture (separation of concerns)
- **Positive:** Can adapt to different cultures and languages
- **Negative:** More complex than single-family app
- **Negative:** Must test with multiple configurations

---

## ADR-002: Original Language Storage with Translate-on-Read

**Date:** 2026-01-10
**Status:** Accepted

**Context:**
Family is multi-lingual. Need to:
- Support code-switching (natural language mixing)
- Preserve what was actually said
- Make content accessible in any language
- Honor speaker's choice of language

**Decision:**
Store content in original language only:
- `content_original` - Exact words (sacred, never changed)
- `language_original` - ISO code of original language

Translations generated on-read when needed (not pre-computed).

**Consequences:**
- **Positive:** Preserves authentic voice
- **Positive:** Simpler storage (no duplicate columns)
- **Positive:** No upfront translation API costs
- **Positive:** Can translate to any language on demand
- **Negative:** Translation latency on read (can cache)
- **Trade-off:** Simplicity over pre-computation

---

## ADR-003: Claims Table (Not Direct Facts)

**Date:** 2026-01-10  
**Status:** Accepted

**Context:**  
Family members disagree about facts:
- "Arrived 1889" vs "Arrived 1891"
- "Warsaw" vs "outside Warsaw"
Need to preserve ALL versions without auto-resolving.

**Decision:**  
Create `claims` table where every fact is a claim with:
- Source (who said it)
- Confidence level
- Certainty language ("definitely" vs "I think")
- Links to conflicting claims

**Consequences:**
- **Positive:** Clear provenance for every fact
- **Positive:** Easy to detect and preserve conflicts
- **Positive:** Can track confidence and uncertainty
- **Positive:** Audit trail for everything
- **Negative:** More complex than single facts table
- **Negative:** Queries need to handle multiple claims
- **Trade-off:** Data integrity worth the complexity

---

## ADR-004: Single Writer Pattern

**Date:** 2026-01-10  
**Status:** Accepted

**Context:**  
Multiple agents need database access but:
- Race conditions possible
- Data integrity critical
- Audit trail required

**Decision:**  
ONLY Registrar can modify core tables:
- Scribes output domain models
- Registrar maps to database schema
- All writes go through single component

**Consequences:**
- **Positive:** No race conditions
- **Positive:** Clear responsibility
- **Positive:** Single point for validation
- **Positive:** Easy to audit
- **Negative:** Bottleneck if volume is high
- **Trade-off:** Correctness > speed

---

## ADR-005: Ordered Sequential Processing

**Date:** 2026-01-10  
**Status:** Accepted

**Context:**  
Messages arrive in sequence, context matters:
- "My grandfather" then "He ran a shop" - "He" refers to grandfather
- Processing out of order breaks context

**Decision:**  
Use ordered queue, process one message at a time sequentially.

**Consequences:**
- **Positive:** Context preserved
- **Positive:** Correct entity resolution
- **Positive:** Simpler reasoning
- **Negative:** Slower than parallel processing
- **Negative:** Can't scale horizontally easily
- **Trade-off:** Correctness > throughput (for now)

---

## ADR-006: Facilitator Tracks Activity, Not Content

**Date:** 2026-01-10  
**Status:** Accepted

**Context:**  
Need to detect:
- Active conversations (don't interrupt)
- Silence (re-engage)
But don't want duplicate content processing.

**Decision:**  
Facilitator gets lightweight activity stream:
- Timestamps, sender IDs, message counts
- Does NOT get message content
- Scribe handles all content processing

**Consequences:**
- **Positive:** Clear separation of concerns
- **Positive:** No duplicate processing
- **Positive:** Facilitator stays lightweight
- **Negative:** Can't make content-based decisions
- **Trade-off:** Worth it for clean architecture

---

## ADR-007: Event Log for Complete Audit

**Date:** 2026-01-10  
**Status:** Accepted

**Context:**  
Need to:
- Debug issues ("why didn't it ask?")
- Track system behavior
- Provide analytics
- Audit all actions

**Decision:**  
Create comprehensive event log:
- All decisions (asked/didn't ask question)
- All rule changes (coaching adjustments)
- All conflicts detected
- All system events

**Consequences:**
- **Positive:** Complete audit trail
- **Positive:** Debugging power
- **Positive:** Analytics capability
- **Positive:** Transparency
- **Negative:** Storage overhead
- **Trade-off:** Worth it for production system

---

## ADR-008: Redaction System (Soft + Hard Delete)

**Date:** 2026-01-10  
**Status:** Accepted

**Context:**  
Mistakes happen:
- Someone shares SSN by accident
- Family wants to remove embarrassing story
- GDPR "right to be forgotten"

**Decision:**  
Two-tier redaction:

**Soft Delete (Default):**
- Mark as redacted
- Keep for audit
- Cascade to derived claims

**Hard Delete (GDPR):**
- Permanently remove
- Log intention first
- Break audit trail (necessary)

**Consequences:**
- **Positive:** Privacy protection
- **Positive:** GDPR compliance
- **Positive:** Mistake recovery
- **Negative:** Complexity
- **Trade-off:** Legal requirement, must have

---

## ADR-009: Pluggable Chat Provider

**Date:** 2026-01-10
**Status:** Accepted

**Context:**
Need chat platform integration. Many options exist (Telegram, WhatsApp, Discord, Slack, etc.) with varying APIs, features, and target audiences.

**Decision:**
Build provider-agnostic interface:
- Define `ChatProvider` interface in `libs/chat-provider/`
- Each provider implements the interface (Telegram, WhatsApp, etc.)
- Store provider-specific metadata in `conversation_events.metadata`
- Core system never directly depends on specific provider

**Interface Contract:**
- Send message to chat
- Receive messages from chat
- Handle media (images, documents)
- Manage group membership

**Consequences:**
- **Positive:** No lock-in to single platform
- **Positive:** Families can use their preferred chat app
- **Positive:** Provider abstraction enables future flexibility
- **Negative:** Slightly more code than direct integration
- **Trade-off:** Worth the abstraction for flexibility

---

## ADR-010: Supabase for Database

**Date:** 2026-01-10  
**Status:** Accepted

**Context:**  
Need database quickly for POC.

**Decision:**  
Use Supabase:
- PostgreSQL (mature, reliable)
- Fast setup
- Generous free tier
- Can migrate later if needed

**Consequences:**
- **Positive:** Quick start
- **Positive:** PostgreSQL power
- **Positive:** Low cost for POC
- **Negative:** Vendor lock-in (mild)
- **Trade-off:** Speed > pure independence for POC

---

## ADR-011: Async Media Processing

**Date:** 2026-01-10  
**Status:** Accepted

**Context:**  
Photo analysis takes time. Don't want to:
- Block text message processing
- Make family wait for response
- Lose message order

**Decision:**  
Process media asynchronously:
- Text Scribe detects image
- Delegates to Curator (background)
- Continues processing text
- Media results feed back when ready

**Consequences:**
- **Positive:** Don't block text flow
- **Positive:** Better user experience
- **Positive:** Can process multiple images in parallel
- **Negative:** More complex architecture
- **Trade-off:** Worth it for responsiveness

---

## ADR-012: Scribe Detects Answers (Not Facilitator)

**Date:** 2026-01-10  
**Status:** Accepted

**Context:**  
Who checks if message answers pending question?

**Decision:**  
Scribe handles answer detection:
- Already processing all message content
- Has context of questions
- Natural fit

**Consequences:**
- **Positive:** Single content processor
- **Positive:** Avoids duplicate work
- **Positive:** Scribe has full context
- **Negative:** Scribe slightly larger
- **Trade-off:** Clean separation

---

## ADR-013: Minimal Configuration Levers (MVP)

**Date:** 2026-01-10  
**Status:** Accepted

**Context:**  
Could have 50+ configuration options. For MVP, need balance.

**Decision:**  
Start with 29 essential levers:
- 13 personality (user-facing)
- 11 technical backend
- 5 real-time flow

Can expand later based on actual needs.

**Consequences:**
- **Positive:** Not overwhelming
- **Positive:** Covers 90% of cases
- **Positive:** Can add more later
- **Negative:** Might miss some edge cases
- **Trade-off:** Simplicity for POC

---

## ADR-014: Cultural Terms Never Translated

**Date:** 2026-01-10  
**Status:** Accepted

**Context:**  
Words like "pulpería", "gallo pinto" don't translate well.
"Corner store" loses cultural meaning.

**Decision:**  
Maintain list of cultural terms that are:
- Never translated
- Explained in parentheses when needed
- Preserved in both language versions

**Consequences:**
- **Positive:** Preserves cultural identity
- **Positive:** Educates family about heritage
- **Positive:** Richer, more authentic
- **Negative:** Requires configuration
- **Trade-off:** Authenticity worth the effort

---

## ADR-015: Warmth as Non-Negotiable Product Requirement

**Date:** 2026-01-10  
**Status:** Accepted

**Context:**  
Warmth is not a "nice feature" - it's the mechanism that makes collection work.

**Decision:**  
Make warmth a core architectural requirement:
- Four-part formula mandatory
- System prompts enforce it
- Testing checks for it
- Documentation emphasizes it

**Consequences:**
- **Positive:** Consistent user experience
- **Positive:** Higher engagement
- **Positive:** Better data quality
- **Negative:** Requires more careful prompt engineering
- **Trade-off:** This IS the product

---

## ADR-016: Family-Scoped Data Model

**Date:** 2026-01-10  
**Status:** Accepted

**Context:**  
Sobremesa is designed to preserve the history of individual families.  
Multiple families may use the system, but their data must remain fully isolated:
- No cross-family deduplication
- No shared timelines or entities
- No accidental data bleed

**Decision:**  
All persisted data is scoped by `family_id`:
- Every content and system table includes `family_id`
- All reads, writes, and deduplication are constrained within a family
- Queues, coaching rules, and configuration are all family-specific

**Consequences:**
- **Positive:** Strong isolation guarantees
- **Positive:** Clear domain boundary
- **Positive:** Prevents cross-family data corruption
- **Negative:** Slightly more verbose schema and queries
- **Trade-off:** Safety and clarity outweigh minimal complexity

---

## ADR-017: Question Lifecycle as a First-Class Entity

**Date:** 2026-01-10  
**Status:** Accepted

**Context:**  
Collecting family history requires asking questions carefully and at the right time.
Questions are not just messages — they have:
- Intent
- Timing constraints
- Outcomes (answered, ignored, retired)

Multiple agents participate in the process.

**Decision:**  
Questions are treated as first-class entities with a lifecycle:
- Scribe and Curator propose questions
- Facilitator decides if/when to ask
- Scribe detects answers
- Registrar persists state changes
- Admin adapts behavior based on outcomes

**Consequences:**
- **Positive:** Clear separation of responsibilities
- **Positive:** Better timing and warmth
- **Positive:** Enables analytics and coaching
- **Negative:** Additional table and complexity
- **Trade-off:** Improves data quality and user trust

---

## ADR-018: Deduplication Applies Only to Entities, Not Claims

**Date:** 2026-01-10  
**Status:** Accepted

**Context:**  
Multiple people may assert different facts about the same event.
Automatically merging or deduplicating these assertions would erase family memory differences.

**Decision:**  
Deduplication is applied only to entity identity (people, places, events).
Claims are never deduplicated or merged; conflicting claims are preserved and linked.

**Consequences:**
- **Positive:** Preserves divergent memories
- **Positive:** Maintains provenance
- **Positive:** Avoids false certainty
- **Negative:** More data to manage
- **Trade-off:** Historical integrity over simplification

---

## ADR-019: Catalog Human-Asked Questions Without System Re-Asking

**Date:** 2026-01-10  
**Status:** Accepted

**Context:**  
Family members naturally ask questions in conversation (e.g., “Who is in this photo?”, “What year was that?”). These questions are valuable signals about gaps in family knowledge and often receive answers that should become claims. Human-origin questions are not placed into the Facilitator’s normal outbound queue. However, if a human-origin question remains unanswered beyond a configurable delay, the Facilitator may post a single gentle follow-up (rate-limited, warmth-formula, and subject to real-time conversation/sensitivity checks). Human-origin questions are excluded from coaching “ignored question” metrics unless the Facilitator actually posts a follow-up.

**Decision:**  
Store family-member questions in the `questions` table as first-class records, marked with `origin='human'` and attributed to the asking person/message. Human-origin questions:
- are eligible for answer detection and claim generation
- are linkable to stories/entities via context
- are **never** placed into the Facilitator’s outbound question queue
- are excluded from coaching performance metrics (ignored/answered rates)

System-generated questions (from Scribe/Curator) continue to follow the standard lifecycle (proposed → asked → answered/retired).

**Consequences:**
- **Positive:** Preserves organic family curiosity as part of history
- **Positive:** Improves provenance (“this answer responded to Aunt Sarah’s question”)
- **Positive:** Avoids duplicate or intrusive re-asking by the system
- **Positive:** Keeps coaching metrics clean and interpretable
- **Negative:** Requires origin attribution and a small amount of filtering logic
- **Trade-off:** Slight added complexity for significantly better fidelity and user experience

---

## ADR-020: One Bot Instance Per Family

**Date:** 2026-01-10
**Status:** Accepted

**Context:**
Need to decide deployment model for multi-family support:
- Option A: Single bot instance handles multiple families (shared infrastructure)
- Option B: Separate bot instance per family (complete isolation)

**Decision:**
Deploy one bot instance per family:
- Each family gets its own running process
- Family ID configured via environment variable
- Complete process isolation between families
- Can scale families independently

**Deployment:**
```bash
# Family A
FAMILY_ID=family-a-uuid npm start

# Family B (separate process)
FAMILY_ID=family-b-uuid npm start
```

**Consequences:**
- **Positive:** Complete isolation (bugs can't affect other families)
- **Positive:** Easy to scale per family
- **Positive:** Simpler code (no multi-tenant routing)
- **Positive:** Family-specific config in env vars
- **Negative:** More infrastructure (one instance per family)
- **Trade-off:** Isolation and simplicity outweigh infrastructure overhead

---

## ADR-021: Intern Agent for Lightweight Preprocessing (Haiku)

**Date:** 2026-01-12
**Status:** Accepted

**Context:**
The Scribe agent uses Claude Sonnet for high-quality entity extraction, but:
- Many messages don't contain relevant family history content
- Running Sonnet on every message is expensive
- Some tasks (filtering, image linking) don't require Sonnet's full capabilities
- Need to reduce API costs while maintaining quality

**Decision:**
Create an "Intern" agent that uses Claude Haiku (`claude-3-5-haiku-20241022`) for lightweight preprocessing tasks:

**Tasks:**
1. **Message Filtering** - Determines if a message is relevant for Scribe extraction
2. **Image Linking** - Detects when text messages reference recently shared images

**Pipeline Position:**
```
Message → Intern (filter) → Scribe → Intern (image link) → Registrar
```

**Image Reference Types:**
- `describes` - Text describes image content
- `identifies_people` - Text identifies people in image
- `provides_context` - Text provides date, location, or event context
- `asks_about` - Text asks a question about the image

**Consequences:**
- **Positive:** Significant cost savings (Haiku is ~10x cheaper than Sonnet)
- **Positive:** Faster preprocessing (Haiku has lower latency)
- **Positive:** Catches image references Scribe might miss (specialized task)
- **Positive:** Domain model augmentation pattern is extensible
- **Negative:** Additional agent to maintain
- **Negative:** Two-step image detection (Scribe + Intern fallback)
- **Trade-off:** Cost efficiency worth the added complexity

---

## ADR-022: Domain Model Augmentation Pattern

**Date:** 2026-01-12
**Status:** Accepted

**Context:**
Scribe extracts domain models from messages, but may miss certain patterns (e.g., image references). Need a way for other agents to enhance the domain model without duplicating Scribe's work.

**Decision:**
Implement domain model augmentation pattern:
1. Scribe produces initial domain model
2. Subsequent agents (e.g., Intern image linker) can add to the model
3. Registrar receives the final augmented model
4. Augmentations are marked with lower confidence (e.g., `MEDIUM` vs Scribe's `HIGH`)

**Implementation:**
```typescript
// If Scribe missed image reference, Intern adds it
if (!alreadyDetected) {
  domainModel.imageReferences = [
    ...existingRefs,
    {
      imageId: linkResult.imageId,
      referenceType: linkResult.referenceType,
      confidence: Confidence.MEDIUM, // Lower than Scribe
    },
  ];
}
```

**Consequences:**
- **Positive:** Specialized agents can improve extraction quality
- **Positive:** Clear confidence attribution (who detected what)
- **Positive:** Extensible for future augmentation agents
- **Positive:** No modification of Scribe code required
- **Negative:** Requires careful coordination of agent execution order
- **Trade-off:** Flexibility worth the orchestration complexity

---

## Summary of Key Architectural Themes

**1. Configurability** - Work for any family, any culture, any language

**2. Data Integrity** - Claims-based, conflict preservation, provenance

**3. Adaptive Intelligence** - Coach monitors and optimizes

**4. Warmth First** - Core mechanism, not optional

**5. Clean Separation** - Each component focused, single writer

**6. Audit Everything** - Event log, blockchain option, complete trail

**7. Privacy Respect** - Redaction, GDPR compliance

**8. Practical Tradeoffs** - Correctness > speed, quality > throughput

---

These decisions create a system that is:
- Technically sound
- Emotionally intelligent
- Culturally adaptable
- Privacy-respecting
- Audit-transparent

All in service of the mission: preserving family history with warmth.
