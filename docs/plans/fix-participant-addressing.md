# Fix Bot Addressing People Mentioned in Stories (Revised)

---

## ⚠️ IMPLEMENTATION STATUS: DORMANT BUG (Not Currently Active)

**THIS BUG IS NOT CURRENTLY HAPPENING** because question generation has been disabled. However, the bug will **immediately activate** as soon as questions are generated again (Historian agent, batch jobs, etc.).

**Why dormant:**

- Scribe no longer generates questions (intentionally removed per `2026-01-25-question-generation-future-work.md`)
- Questions table is empty
- `Facilitator.sendQuestion()` is active but has no questions to send
- Returns "No pending questions" on every call

**When it will activate:**

- Historian agent starts generating questions
- Batch question generation is implemented
- Manual questions are added via admin interface
- As soon as ANY question with `targetPerson` exists, the addressing bug manifests

**Recommendation:** Implement this fix BEFORE re-enabling question generation to prevent the bug from ever occurring in production.

---

## Problem

The bot incorrectly addresses people mentioned in stories as if they're actual chat participants.

**This is actually TWO distinct problems:**

1. **Participant Verification** (Who CAN we address?) - Checking if someone is actually in the chat
2. **Question Targeting** (Who SHOULD we address?) - Choosing the right person to ask

Both must be solved for correct addressing behavior.

**Example:**

- User: "But what would Nick say if he never would have married Judy?"
- Bot: "Nick, it's so wonderful to have you here sharing with us!"
- **Bug**: Nick and Judy are historical figures mentioned in the story, not actual chat members

## Root Cause

The system has no distinction between:

1. **Actual chat participants** - people who send messages (`actor_external_id` in conversation_events)
2. **Mentioned people** - historical figures, deceased relatives, people in stories (extracted by Scribe)

**Current flow (when questions are generated):**

1. User mentions "Nick" in a story
2. Question generation agent sets: `targetPerson: "Nick"`
3. Facilitator receives question with `targetPerson: "Nick"`
4. `buildUserPrompt()` adds: `**Who to ask:** Nick`
5. Facilitator prompt says: "address them directly"
6. Result: "Nick, this story..." ❌

### The Two Problems in Detail

#### Problem 1: Participant Verification (Who CAN we address?)

**Issue:** No check if `targetPerson` is actually in the chat

**Scenario:**

- Bob says: "What would Nick say if he never married Judy?"
- Nick/Judy are historical figures (deceased, not in chat)
- Question gets `targetPerson: "Nick"`
- Bot addresses Nick directly even though he's not a participant ❌

**Solution:** Check if person has sent messages (`actor_external_id` exists in conversation_events)

#### Problem 2: Question Targeting (Who SHOULD we address?)

**Issue:** No logic for choosing WHO to ask when multiple people are involved

**Scenario:**

- Bob says: "Jim and Becky are my cousins and we love tacos on Tuesday"
- All three (Bob, Jim, Becky) ARE in the chat
- Question could be addressed to Bob (story teller), Jim, Becky, or the group
- Current system has no targeting strategy ⚠️

**Solution:** Define explicit targeting rules for question generation:

- Ask story TELLER for elaboration ("Bob, tell us more about taco Tuesday!")
- Ask MENTIONED people for their perspective ("Jim, what's your favorite taco place?")
- Ask the GROUP for open-ended questions ("Does anyone remember other family traditions?")

**Both problems must be solved:**

- Problem 1 prevents addressing non-participants (safety check)
- Problem 2 ensures we ask the RIGHT participant (smart targeting)

---

## Solution: Participant Tracking via actor_external_id

Add proper participant tracking anchored to `actor_external_id` (not display names).

### Key Principles

1. **`actor_external_id` is source of truth** - provider's unique identifier
2. **Conversation-specific** - participant status is per-conversation
3. **Incremental sync** - process only new events, not rescanning
4. **Strict allowlist** - only address if `isTargetParticipant === true`
5. **Leverage existing identities** - link to person via identities table

### Architecture

```
conversation_events.actor_external_id
  ↓ (match via identities OR create)
identities.id
  ↓ (link to person)
conversation_participants (NEW)
  ↓
person_id → Person record
```

**Benefits:**

- Resilient to name changes, emojis, punctuation
- Handles multiple people with same display name
- Conversation-specific (can participate in one chat but not another)
- Enables recency tracking (`last_seen_at`)
- Works with multi-provider (Telegram, WhatsApp, etc.)

---

## Solution Part 2: Question Targeting Strategy

**Problem:** Even with participant tracking, we need rules for WHO to ask.

### Targeting Rules for Question Generation

When the question generation agent (Historian) creates questions, it should follow these rules:

#### Rule 1: Story Teller Gets Elaboration Questions

If asking for more details about what was just shared:

```typescript
// Bob says: "Jim and I went to MIT together"
{
  targetPerson: "Bob",  // Ask the teller
  content: "Tell us more about your time at MIT with Jim!"
}
```

**Rationale:** They initiated the topic and have fresh context

#### Rule 2: Mentioned People Get Perspective Questions

If asking for a different viewpoint on the story:

```typescript
// Bob says: "Jim graduated top of his class"
{
  targetPerson: "Jim",  // Ask the subject
  content: "Jim, what was your MIT experience like?"
}
```

**Rationale:** Gets their voice into the conversation

#### Rule 3: Group Gets Open-Ended Questions

If asking about broader context or family patterns:

```typescript
// Bob says: "We had a family reunion in 1985"
{
  targetPerson: null,  // Ask everyone
  content: "Does anyone remember other family reunions from that era?"
}
```

**Rationale:** Inclusive, anyone can contribute

#### Rule 4: Historical Figures Never Targeted

If a person is mentioned but clearly not present (deceased, historical):

```typescript
// Bob says: "Great-grandpa Joe fought in WWI"
{
  targetPerson: null,  // Don't target Joe
  content: "Does anyone know more about Great-grandpa Joe's war experience?"
}
```

**Rationale:** Safety - never address someone who can't respond

### Implementation in Question Generation

**File:** Future Historian agent or question generation logic

```typescript
interface QuestionTargetingContext {
  storyTeller: Person; // Who sent the message
  mentionedPeople: Person[]; // Extracted from content
  conversationParticipants: Person[]; // Who is in the chat
}

function selectTargetPerson(
  questionType: 'elaboration' | 'perspective' | 'context',
  context: QuestionTargetingContext,
): Person | null {
  switch (questionType) {
    case 'elaboration':
      // Ask the story teller
      return context.storyTeller;

    case 'perspective':
      // Ask someone mentioned who is also a participant
      const eligibleTargets = context.mentionedPeople.filter(
        (p) =>
          context.conversationParticipants.some((cp) => cp.id === p.id) &&
          p.id !== context.storyTeller.id, // Don't re-ask teller
      );
      return eligibleTargets[0] || null; // Pick first, or group question

    case 'context':
      // Ask the group
      return null;
  }
}
```

### Interaction with Participant Verification

The two systems work together:

1. **Question Generation** (Historian): Sets `targetPerson` using targeting rules
2. **Participant Verification** (Facilitator): Validates `targetPerson` is actually in chat

```typescript
// Historian generates question
const question = {
  content: 'Tell us more about taco Tuesday!',
  targetPerson: 'Bob', // Targeting logic chose Bob
  questionType: 'elaboration',
};

// Facilitator verifies before sending
const isBobPresent = await participantRepo.isParticipant(
  familyId,
  conversationId,
  bobPersonId,
);

if (isBobPresent) {
  // Safe to address Bob
  sendMessage('Bob, tell us more about taco Tuesday!');
} else {
  // Bob mentioned but not present - ask group instead
  sendMessage('Tell us more about taco Tuesday!');
}
```

**Key principle:** Targeting picks WHO to ask, verification ensures SAFETY.

---

## Implementation

### Step 1: Create conversation_participants Table

**File:** `apps/db/supabase/migrations/YYYYMMDDHHMMSS_add_conversation_participants.sql`

```sql
-- Track who is actually participating in each conversation
CREATE TABLE IF NOT EXISTS conversation_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL, -- TEXT is safer (no length limit, supports composite keys)

  -- Link to person (the genealogy entity)
  -- NULL until matched via findBestMatch
  person_id UUID REFERENCES people(id) ON DELETE CASCADE,

  -- Link to identity (the chat provider account) - SOURCE OF TRUTH
  identity_id UUID NOT NULL REFERENCES identities(id) ON DELETE CASCADE,

  -- Activity tracking
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), -- TODO: Add trigger to auto-update, or remove if not using

  -- One participant record per (family, conversation, identity)
  -- family_id included to prevent cross-family collisions if conversation_id isn't globally unique
  UNIQUE (family_id, conversation_id, identity_id)
);

CREATE INDEX idx_conversation_participants_conversation
  ON conversation_participants(family_id, conversation_id);

CREATE INDEX idx_conversation_participants_person
  ON conversation_participants(family_id, person_id)
  WHERE person_id IS NOT NULL;

CREATE INDEX idx_conversation_participants_active
  ON conversation_participants(family_id, conversation_id, last_seen_at DESC);

COMMENT ON TABLE conversation_participants IS
'Tracks who is actively participating in each conversation, anchored to identity_id (which links to provider + actor_external_id).';

COMMENT ON COLUMN conversation_participants.person_id IS
'Link to the Person entity (can be NULL if not yet matched via findBestMatch).';

COMMENT ON COLUMN conversation_participants.identity_id IS
'Link to the chat provider identity (source of truth for participant identity).';

COMMENT ON COLUMN conversation_participants.first_seen_at IS
'When this identity first sent a message in this conversation.';

COMMENT ON COLUMN conversation_participants.last_seen_at IS
'Most recent message/activity from this identity in this conversation. Updated on each event.';
```

**Why this design:**

- `identity_id` is source of truth (anchored to `actor_external_id`)
- `person_id` can be nullable (allows gradual matching)
- `conversation_id` scopes participation to specific chats
- `last_seen_at` enables recency filtering
- Separate from people table (doesn't conflate "entity exists" with "is participant")

**Prerequisites / Invariants:**

1. **identities table MUST have:** `UNIQUE(provider, provider_user_id)`
   - This is the linchpin for "actor_external_id is source of truth"
   - Already exists in schema ✅ (verified in 20260112074715_init_schema.sql)

2. **conversation_id type consistency:**
   - Using TEXT for future-proofing (no length limits, supports composite keys)
   - NOTE: If `conversation_events.conversation_id` is currently VARCHAR(255), consider migrating to TEXT later
   - For now, conversation_participants uses TEXT regardless (more flexible)

3. **Auto-update trigger for updated_at:**
   - Either add standard trigger to update `updated_at` on row changes, OR
   - Remove `updated_at` column (keep lean)
   - Same applies to identities table if using update tracking

---

### Step 2: Add Participant Repository Methods

**File:** `libs/database/src/lib/repositories/participant-repository.ts` (create new)

```typescript
import { createClient } from '@supabase/supabase-js';
import { createLogger } from '@sobremesa/shared-utils';
import type { ConversationParticipant } from '@sobremesa/shared-types';

const logger = createLogger({ name: 'participant-repo' });

export interface ConversationParticipant {
  id: string;
  familyId: string;
  conversationId: string;
  personId?: string;
  identityId: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export class ParticipantRepository {
  constructor(
    private client: ReturnType<typeof createClient>,
    private personRepo: PersonRepository,
  ) {}

  /**
   * Upsert a participant (create or update last_seen_at).
   * Does NOT touch person_id (use linkParticipantToPerson for that).
   * Returns the row including existing person_id if already linked.
   *
   * This is the PRIMARY method for participant tracking.
   */
  async upsertParticipant(
    familyId: string,
    conversationId: string,
    identityId: string,
  ): Promise<ConversationParticipant> {
    const now = new Date().toISOString();

    const { data, error } = await this.client
      .from('conversation_participants')
      .upsert(
        {
          family_id: familyId,
          conversation_id: conversationId,
          identity_id: identityId,
          last_seen_at: now,
          // Do NOT include person_id here - prevents accidental unlinking
        },
        {
          onConflict: 'family_id,conversation_id,identity_id',
          // On conflict: updates last_seen_at (and other non-key columns in payload)
        },
      )
      .select()
      .single();

    if (error) {
      logger.error(
        { error, familyId, identityId },
        'Failed to upsert participant',
      );
      throw error;
    }

    return data as ConversationParticipant;
  }

  /**
   * Find all active participants in a conversation.
   * Optionally filter by recency (last_seen_at > cutoff).
   */
  async findParticipants(
    familyId: string,
    conversationId: string,
    options?: {
      activeSince?: Date; // Only participants seen after this date
      includeUnmatched?: boolean; // Include participants without person_id
    },
  ): Promise<ConversationParticipant[]> {
    let query = this.client
      .from('conversation_participants')
      .select('*')
      .eq('family_id', familyId)
      .eq('conversation_id', conversationId);

    if (options?.activeSince) {
      query = query.gte('last_seen_at', options.activeSince.toISOString());
    }

    if (!options?.includeUnmatched) {
      query = query.not('person_id', 'is', null);
    }

    const { data, error } = await query;

    if (error) {
      logger.error({ error, familyId }, 'Failed to find participants');
      throw error;
    }

    return (data as ConversationParticipant[]) || [];
  }

  /**
   * Check if a person is a participant in a conversation.
   * Optionally filter by recency (only "active" participants).
   */
  async isParticipant(
    familyId: string,
    conversationId: string,
    personId: string,
    options?: {
      activeSince?: Date; // Only consider participant if last_seen_at > this
    },
  ): Promise<boolean> {
    let query = this.client
      .from('conversation_participants')
      .select('id, last_seen_at')
      .eq('family_id', familyId)
      .eq('conversation_id', conversationId)
      .eq('person_id', personId);

    if (options?.activeSince) {
      query = query.gte('last_seen_at', options.activeSince.toISOString());
    }

    const { data, error } = await query.single();

    if (error && error.code !== 'PGRST116') {
      // PGRST116 = not found (expected)
      logger.error(
        { error, familyId, personId },
        'Failed to check participant',
      );
      return false;
    }

    return !!data;
  }

  /**
   * Link an identity to a person (after matching).
   * Validates that person belongs to the same family (prevents cross-family links).
   */
  async linkParticipantToPerson(
    familyId: string,
    conversationId: string,
    identityId: string,
    personId: string,
  ): Promise<void> {
    // Verify person belongs to same family (prevents catastrophic cross-family bugs)
    const person = await this.personRepo.findById(familyId, personId);
    if (!person || person.familyId !== familyId) {
      const error = new Error(
        `Person ${personId} does not belong to family ${familyId}`,
      );
      logger.error({ familyId, personId }, error.message);
      throw error;
    }

    const { error } = await this.client
      .from('conversation_participants')
      .update({ person_id: personId })
      .eq('family_id', familyId) // Belt AND suspenders
      .eq('conversation_id', conversationId)
      .eq('identity_id', identityId);

    if (error) {
      logger.error(
        { error, identityId, personId },
        'Failed to link participant to person',
      );
      throw error;
    }
  }
}
```

---

### Step 3: Incremental Participant Sync

**File:** `libs/agents/registrar/src/lib/participant-sync.ts` (create new)

```typescript
import {
  IdentityRepository,
  ParticipantRepository,
  PersonRepository,
} from '@sobremesa/database';
import { createLogger } from '@sobremesa/shared-utils';
import type { ConversationEvent } from '@sobremesa/shared-types';

const logger = createLogger({ name: 'participant-sync' });

/**
 * Sync a SINGLE event's actor to participants table.
 * This is called for each new event as it's ingested (incremental).
 */
export async function syncEventActor(
  event: ConversationEvent,
  familyId: string,
): Promise<void> {
  const identityRepo = new IdentityRepository();
  const participantRepo = new ParticipantRepository();
  const personRepo = new PersonRepository();

  // Step 1: Find or create identity for this actor
  let identity = await identityRepo.findByProviderUser(
    event.source, // 'telegram', 'whatsapp', etc.
    event.actorExternalId,
  );

  if (!identity) {
    // Create new identity
    identity = await identityRepo.create({
      provider: event.source,
      providerUserId: event.actorExternalId,
      providerUsername: event.actorUsername,
      displayName: event.actorDisplayName,
    });

    logger.info(
      {
        familyId,
        identityId: identity.id,
        provider: event.source,
        actorExternalId: event.actorExternalId,
      },
      'Created new identity for actor',
    );
  } else {
    // Update display name if changed
    if (
      event.actorDisplayName &&
      event.actorDisplayName !== identity.displayName
    ) {
      await identityRepo.update(identity.id, {
        displayName: event.actorDisplayName,
        providerUsername: event.actorUsername,
      });
    }
  }

  // Step 2: Upsert participant record
  // This updates last_seen_at and returns the current row (including person_id if already linked)
  const participant = await participantRepo.upsertParticipant(
    familyId,
    event.conversationId,
    identity.id,
  );

  // Step 3: Try to match identity → person (if not already linked)
  if (!participant.personId) {
    // Not yet matched to a person - try matching by display name
    const matchResult = await personRepo.findBestMatch(
      familyId,
      event.actorDisplayName || event.actorUsername || 'Unknown',
      [], // No aliases from actor side
    );

    if (matchResult) {
      // IMPORTANT: Only auto-link if confidence is high enough
      // Prevents accidental mis-linking when there are multiple "David"s
      // NOTE: Adjust these matchReason strings to match your findBestMatch implementation
      // Common values: 'exact', 'alias', 'fuzzy', etc.
      const isHighConfidence =
        matchResult.matchReason === 'exact' ||
        matchResult.matchReason === 'alias' ||
        (matchResult.confidence && matchResult.confidence >= 0.9);

      if (isHighConfidence) {
        await participantRepo.linkParticipantToPerson(
          familyId,
          event.conversationId,
          identity.id,
          matchResult.person.id,
        );

        logger.info(
          {
            familyId,
            identityId: identity.id,
            personId: matchResult.person.id,
            personName: matchResult.person.name,
            actorName: event.actorDisplayName,
            matchReason: matchResult.matchReason,
            confidence: matchResult.confidence,
          },
          'Linked participant to person (high confidence)',
        );
      } else {
        logger.warn(
          {
            familyId,
            identityId: identity.id,
            actorName: event.actorDisplayName,
            matchReason: matchResult.matchReason,
            confidence: matchResult.confidence,
            possiblePersonId: matchResult.person.id,
          },
          'Match found but confidence too low for auto-link (requires manual linking)',
        );
      }
    } else {
      logger.debug(
        {
          familyId,
          identityId: identity.id,
          actorName: event.actorDisplayName,
        },
        'No person match found for participant (will retry later)',
      );
    }
  } else {
    // Already linked - don't rematch (prevents thrashing)
    logger.debug(
      {
        familyId,
        identityId: identity.id,
        personId: participant.personId,
      },
      'Participant already linked to person',
    );
  }
}
```

**Why incremental:**

- Only processes the single event being ingested
- No rescanning of 1000 events
- Cheap and fast
- Participant tracking stays up-to-date automatically

---

### Step 4: Update Registrar to Call Sync

**File:** `libs/agents/registrar/src/lib/registrar.ts`

**Location:** At the END of `persist()` method

```typescript
async persist(
  domainModel: ScribeDomainModel,
  familyId: string,
): Promise<void> {
  // ... all existing persistence logic ...

  // Sync the SOURCE EVENT's actor to participants
  // (not all actors - just the one who sent this message)
  try {
    const sourceEvent = await this.conversationEventRepo.findById(
      familyId,
      domainModel.sourceEventId
    );

    if (sourceEvent) {
      await syncEventActor(sourceEvent, familyId);
    }
  } catch (error) {
    // Don't fail persist if sync fails
    this.logger.warn({
      error,
      familyId,
      sourceEventId: domainModel.sourceEventId,
    }, 'Failed to sync event actor');
  }

  this.logger.info({ familyId, result }, 'Registrar persist complete');
}
```

---

### Step 5: Update Facilitator to Check Participants

**File:** `libs/agents/facilitator/src/lib/prompt-builder.ts`

**Change:** Make addressing strict allowlist

```typescript
export function buildUserPrompt(
  question: Question,
  isTargetParticipant?: boolean, // Explicit tri-state: true/false/undefined
): string {
  const parts: string[] = [];

  parts.push('Please apply the warmth formula to this question:');
  parts.push('');
  parts.push(`**Question:** ${question.contentOriginal}`);

  if (question.targetPerson) {
    if (isTargetParticipant === true) {
      // ONLY include "Who to ask" if explicitly verified
      parts.push(`**Who to ask:** ${question.targetPerson}`);
    } else {
      // Either false (confirmed not participant) or undefined (unknown)
      // In BOTH cases, don't address them directly
      parts.push(
        `**Note:** This question relates to ${question.targetPerson} ` +
          `(story subject; not confirmed present in chat)`,
      );
    }
  }

  // ... rest of code ...

  return parts.join('\n');
}
```

**Key change:** `isTargetParticipant !== false` → `isTargetParticipant === true`

This makes addressing **opt-in**, not default. If check fails or is skipped, fall back to group asking.

**File:** `libs/agents/facilitator/src/lib/facilitator.ts`

```typescript
export class FacilitatorAgent {
  // ... existing fields ...
  private participantRepo: ParticipantRepository; // Add

  constructor(options: FacilitatorAgentOptions) {
    // ... existing ...
    this.participantRepo =
      options.participantRepo || new ParticipantRepository();
  }

  private async sendQuestion(
    family: Family,
    question: Question,
  ): Promise<string> {
    // ... existing validation ...

    let isTargetParticipant: boolean | undefined;

    if (question.targetPerson) {
      // Find person by name
      const matchResult = await this.personRepo.findBestMatch(
        family.id,
        question.targetPerson,
        [],
      );

      if (matchResult) {
        // Check if this person is a participant
        isTargetParticipant = await this.participantRepo.isParticipant(
          family.id,
          family.conversationId,
          matchResult.person.id,
        );

        this.logger.debug(
          {
            targetPerson: question.targetPerson,
            personId: matchResult.person.id,
            isParticipant: isTargetParticipant,
          },
          'Checked participant status',
        );
      } else {
        // No person found → definitely not a participant
        isTargetParticipant = false;

        this.logger.debug(
          {
            targetPerson: question.targetPerson,
          },
          'No person found - not a participant',
        );
      }
    }

    // Apply warmth formula
    if (this.provider && this.model) {
      const systemPrompt = buildSystemPrompt(familyConfig);
      const userPrompt = buildUserPrompt(question, isTargetParticipant);

      // ... rest of warmth transformation ...
    } else {
      questionText = question.contentOriginal;
    }

    // ... rest of code ...
  }
}
```

**File:** `libs/prompts/src/agents/facilitator.txt`

**Lines 152-166:** Add strict instruction

```
## Handling "Who to Ask"

**CRITICAL: Only address people who are actually IN the chat.**

**If "Who to ask" is provided:**
- This person has been VERIFIED as present in the chat
- Address them directly: "Uncle David, this story about the shop..."
- Use their name as a greeting/tag

**If "Note" mentions someone:**
- This person is NOT in the chat (mentioned in stories only, OR verification failed)
- DO NOT address them by name
- DO NOT greet or tag them
- Ask the question to the group warmly, referencing the story subject
- Example: "This story about Nick is fascinating - does anyone remember more details?"

**Formatting rule:**
- ONLY greet/tag someone if the prompt contains "Who to ask:"
- If it's only in "Note:", do not greet/tag them, ever

**Why this matters:** Addressing someone who isn't present ("Nick, it's wonderful...") when Nick is only mentioned in a story confuses the family and breaks immersion.
```

---

## Testing Strategy

### Unit Tests

**File:** `libs/database/src/lib/repositories/participant-repository.spec.ts`

```typescript
describe('ParticipantRepository', () => {
  it('should upsert participant and update last_seen_at', async () => {
    const identity = await identityRepo.create({ ... });

    const p1 = await repo.upsertParticipant(familyId, convId, identity.id);
    expect(p1.identityId).toBe(identity.id);

    // Wait and upsert again
    await new Promise(r => setTimeout(r, 1000));
    const p2 = await repo.upsertParticipant(familyId, convId, identity.id);

    expect(p2.id).toBe(p1.id); // Same record
    expect(new Date(p2.lastSeenAt) > new Date(p1.lastSeenAt)).toBe(true);
  });

  it('should find only matched participants by default', async () => {
    const identity1 = await identityRepo.create({ ... });
    const identity2 = await identityRepo.create({ ... });
    const person = await personRepo.create({ ... });

    await repo.upsertParticipant(familyId, convId, identity1.id);
    await repo.linkParticipantToPerson(familyId, convId, identity1.id, person.id);
    await repo.upsertParticipant(familyId, convId, identity2.id); // No person

    const participants = await repo.findParticipants(familyId, convId);

    expect(participants).toHaveLength(1);
    expect(participants[0].personId).toBe(person.id);
  });

  it('should check participant status by person_id', async () => {
    const identity = await identityRepo.create({ ... });
    const person1 = await personRepo.create({ name: 'María', ... });
    const person2 = await personRepo.create({ name: 'Nick', ... });

    await repo.upsertParticipant(familyId, convId, identity.id);
    await repo.linkParticipantToPerson(familyId, convId, identity.id, person1.id);

    expect(await repo.isParticipant(familyId, convId, person1.id)).toBe(true);
    expect(await repo.isParticipant(familyId, convId, person2.id)).toBe(false);
  });
});
```

**File:** `libs/agents/registrar/src/lib/participant-sync.spec.ts`

```typescript
describe('syncEventActor', () => {
  it('should create identity and participant for new actor', async () => {
    const event: ConversationEvent = {
      source: 'telegram',
      actorExternalId: '12345',
      actorDisplayName: 'María García',
      conversationId: 'chat-1',
      ...
    };

    await syncEventActor(event, familyId);

    // Verify identity created
    const identity = await identityRepo.findByProviderUser('telegram', '12345');
    expect(identity).toBeTruthy();
    expect(identity.displayName).toBe('María García');

    // Verify participant created
    const participants = await participantRepo.findParticipants(familyId, 'chat-1', {
      includeUnmatched: true,
    });
    expect(participants).toHaveLength(1);
    expect(participants[0].identityId).toBe(identity.id);
  });

  it('should link participant to person when match found', async () => {
    // Create a person first
    const person = await personRepo.create(familyId, { name: 'María García', ... });

    const event: ConversationEvent = {
      source: 'telegram',
      actorExternalId: '12345',
      actorDisplayName: 'María García',
      conversationId: 'chat-1',
      ...
    };

    await syncEventActor(event, familyId);

    // Verify participant linked to person
    expect(await participantRepo.isParticipant(familyId, 'chat-1', person.id)).toBe(true);
  });

  it('should NOT link when no person match (leaves person_id null)', async () => {
    const event: ConversationEvent = {
      source: 'telegram',
      actorExternalId: '12345',
      actorDisplayName: 'Unknown Person',
      conversationId: 'chat-1',
      ...
    };

    await syncEventActor(event, familyId);

    const participants = await participantRepo.findParticipants(familyId, 'chat-1', {
      includeUnmatched: true,
    });

    expect(participants).toHaveLength(1);
    expect(participants[0].personId).toBeNull();
  });
});
```

**File:** `libs/agents/facilitator/src/lib/prompt-builder.spec.ts`

```typescript
describe('buildUserPrompt - strict allowlist', () => {
  it('should include "Who to ask" only when isTargetParticipant === true', () => {
    const question = { targetPerson: 'Uncle David', ... };

    const prompt = buildUserPrompt(question, true);

    expect(prompt).toContain('**Who to ask:** Uncle David');
    expect(prompt).not.toContain('Note:');
  });

  it('should include "Note" when isTargetParticipant === false', () => {
    const question = { targetPerson: 'Nick', ... };

    const prompt = buildUserPrompt(question, false);

    expect(prompt).not.toContain('**Who to ask:**');
    expect(prompt).toContain('**Note:**');
    expect(prompt).toContain('not confirmed present');
  });

  it('should include "Note" when isTargetParticipant === undefined (unknown)', () => {
    const question = { targetPerson: 'David', ... };

    const prompt = buildUserPrompt(question, undefined);

    expect(prompt).not.toContain('**Who to ask:**');
    expect(prompt).toContain('**Note:**');
  });
});
```

### Manual Testing

- [ ] Actor sends message → identity + participant created automatically
- [ ] Participant linked to person when name matches
- [ ] Person mentioned in story (not participant) → bot asks group
- [ ] Actual participant mentioned → bot addresses them
- [ ] Actor with no person match → participant exists but person_id null (graceful)
- [ ] Display name change → identity updated, participant tracking continues

---

## Critical Files

### Files to Create

1. `apps/db/supabase/migrations/YYYYMMDDHHMMSS_add_conversation_participants.sql`
2. `libs/database/src/lib/repositories/participant-repository.ts`
3. `libs/database/src/lib/repositories/participant-repository.spec.ts`
4. `libs/agents/registrar/src/lib/participant-sync.ts`
5. `libs/agents/registrar/src/lib/participant-sync.spec.ts`

### Files to Modify

6. `libs/shared/types/src/lib/entities.ts` - Add `ConversationParticipant` interface
7. `libs/database/src/index.ts` - Export ParticipantRepository
8. `libs/agents/registrar/src/lib/registrar.ts` - Call `syncEventActor` at end of `persist()`
9. `libs/agents/facilitator/src/lib/facilitator.ts` - Add participant check in `sendQuestion()`
10. `libs/agents/facilitator/src/lib/prompt-builder.ts` - Make addressing strict allowlist
11. `libs/prompts/src/agents/facilitator.txt` - Add strict formatting rule

### Dependencies Needed

#### IdentityRepository Methods

Check if these exist, or add them to `libs/database/src/lib/repositories/identity-repository.ts`:

```typescript
export class IdentityRepository {
  /**
   * Find identity by provider and provider user ID.
   */
  async findByProviderUser(
    provider: string,
    providerUserId: string,
  ): Promise<Identity | null> {
    const { data, error } = await this.client
      .from('identities')
      .select('*')
      .eq('provider', provider)
      .eq('provider_user_id', providerUserId)
      .single();

    if (error && error.code !== 'PGRST116') {
      logger.error(
        { error, provider, providerUserId },
        'Failed to find identity',
      );
      throw error;
    }

    return data as Identity | null;
  }

  /**
   * Create a new identity.
   */
  async create(data: {
    provider: string;
    providerUserId: string;
    providerUsername?: string;
    displayName?: string;
  }): Promise<Identity> {
    const { data: identity, error } = await this.client
      .from('identities')
      .insert({
        provider: data.provider,
        provider_user_id: data.providerUserId,
        provider_username: data.providerUsername,
        display_name: data.displayName,
      })
      .select()
      .single();

    if (error) {
      logger.error({ error, data }, 'Failed to create identity');
      throw error;
    }

    return identity as Identity;
  }

  /**
   * Update identity (display name, username, etc).
   */
  async update(
    id: string,
    updates: {
      displayName?: string;
      providerUsername?: string;
    },
  ): Promise<Identity> {
    const { data, error } = await this.client
      .from('identities')
      .update({
        display_name: updates.displayName,
        provider_username: updates.providerUsername,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      logger.error({ error, id }, 'Failed to update identity');
      throw error;
    }

    return data as Identity;
  }
}
```

---

## Verification

### Success Criteria

#### Participant Verification (Problem 1)

✅ Bot never addresses non-participants (verified via tests)
✅ Bot correctly addresses actual participants
✅ Participant tracking anchored to `actor_external_id` (not display names)
✅ Incremental sync (only processes new events)
✅ Resilient to name changes, multiple "David"s, etc.
✅ `isTargetParticipant === true` required for direct addressing (strict allowlist)

#### Question Targeting (Problem 2)

✅ Story tellers get elaboration questions
✅ Mentioned participants get perspective questions
✅ Group gets open-ended questions
✅ Historical figures never targeted
✅ Targeting rules documented and tested

**Note:** Problem 2 (targeting) will be implemented when question generation is re-enabled (Historian agent). Problem 1 (verification) should be implemented first as a safety mechanism.

---

## Implementation Notes

### Key Improvements Over Original Plan

1. **`actor_external_id` as source of truth** - not fragile display name matching
2. **`conversation_participants` table** - proper relational model, not boolean
3. **Incremental sync** - process only new events, not 1000 events each time
4. **Strict allowlist** - `isTargetParticipant === true` required (not `!== false`)
5. **Identity-first** - leverage existing identities table
6. **Conversation-specific** - participant status scoped to conversation

### Edge Cases Handled

#### Participant Verification Edge Cases

1. **Multiple "David"s** - distinguished by `actor_external_id` ✓
2. **Display name changes** - identity tracks latest, participant tracking unaffected ✓
3. **Person mentioned, then joins** - identity created on join, matched to person ✓
4. **Deceased relatives** - no identity/participant, never addressed ✓
5. **Actor with no person match** - participant exists with `person_id = null`, will retry later ✓
6. **Verification failure** - falls back to group asking (safe) ✓
7. **New member who hasn't sent a message** - NOT considered a participant (message-based approach)
   - Conservative: Only address people who have actively participated
   - Prevents "lurker anxiety" - respects passive observers
   - Alternative: Could use `family_access.status = 'active'` for more inclusive approach
8. **Member joins mid-conversation** - becomes participant after first message
   - Incremental sync automatically tracks them
   - No backfill needed

#### Question Targeting Edge Cases

1. **Story teller mentions themselves** - Bob says "Jim, Becky, and I love tacos"
   - Elaboration question → Ask Bob (the teller)
   - Perspective question → Ask Jim or Becky (others mentioned)
2. **Multiple people mentioned** - Bob says "Jim and Becky went to MIT"
   - Pick one person (Jim or Becky) based on question focus
   - Or ask group if context is unclear
3. **Everyone mentioned is present** - All participants involved in story
   - Use targeting rules to pick most appropriate person
   - Story teller for elaboration, others for perspective
4. **No one mentioned is present** - Story about historical figures
   - Always targetPerson = null (group question)
   - Never address non-participants

### Performance

- **Incremental**: Only syncs the single event being ingested
- **Indexed**: Queries use indexed columns (`conversation_id`, `identity_id`, `person_id`)
- **Cheap upsert**: ON CONFLICT updates only `last_seen_at`

### Alternative: Simpler Query-Based Approach

**Instead of a new `conversation_participants` table**, you could query existing tables:

```sql
-- Check if person has sent messages in this conversation
SELECT DISTINCT 1
FROM conversation_events ce
JOIN identities i
  ON i.provider = ce.source
  AND i.provider_user_id = ce.actor_external_id
JOIN family_access fa
  ON fa.identity_id = i.id
  AND fa.family_id = ce.family_id
  AND fa.status = 'active'
WHERE ce.family_id = ?
  AND ce.conversation_id = ?
  AND fa.person_id = ?
  AND fa.person_id IS NOT NULL  -- Only matched identities
```

**Important:** This query only works for identities that have been linked to people via `family_access.person_id`. Identities that haven't been matched to people yet will not be detected as participants (which is correct behavior - you can't address someone you haven't identified).

**Pros:**

- No new table or sync logic
- Always up-to-date (no eventual consistency)
- Simpler architecture
- Sufficient for 10-50 person families

**Cons:**

- Slightly slower queries (3-table join)
- No built-in recency tracking (would need to add `AND ce.occurred_at > ?`)
- No pre-computed participant roster

**Recommendation:** Start with query-based approach. Add dedicated table later if:

- Performance becomes an issue (hundreds of participants)
- Need fast "list all participants" queries
- Want built-in recency/activity tracking

### Future Enhancements

1. **Store targetPersonId in questions** (improves Facilitator determinism)
   - Currently: Facilitator does `findBestMatch(question.targetPerson)` → then checks participation
   - Better: Scribe/Registrar resolves `targetPerson` → stores `targetPersonId` in question
   - Then: Facilitator checks `isParticipant(targetPersonId)` directly (no fuzzy matching)
   - Benefit: More deterministic, avoids re-matching the same name

2. **Batch person matching** - periodic job to match unlinked participants (person_id NULL)
   - Retry matching for participants where auto-link failed due to low confidence
   - Or manual review UI for "unlinked participants needing attention"

3. **Recency filtering** - use `activeSince` parameter in `isParticipant()` for "currently active" vs "ever participated"
   - Default: no recency check (safe, includes anyone who ever participated)
   - Optional: `activeSince: 30 days ago` for "only address if seen recently"

4. **Cross-conversation identity** - same person in multiple family chats (already supported via global identities)

5. **Manual linking** - admin command to link identity → person when auto-match fails
   - Useful for edge cases where display name doesn't match person name

---

## Key Refinements (v2)

Based on feedback, the following improvements were made:

### 1. Multi-provider safety ✅

- identities table already has `UNIQUE(provider, provider_user_id)` - verified in schema
- conversation_participants has `UNIQUE(family_id, conversation_id, identity_id)` to prevent cross-family collisions

### 2. Type consistency ✅

- `conversation_id` uses `TEXT` for future-proofing (no length limit, supports composite keys)
- NOTE: If `conversation_events.conversation_id` is currently VARCHAR(255), consider migrating later
- Using TEXT in conversation_participants is safer regardless

### 3. Upsert safety ✅

- `upsertParticipant()` does NOT touch `person_id` (prevents accidental unlinking)
- Separate `linkParticipantToPerson()` method for explicit person binding
- Upsert returns the row (including existing `person_id`), avoiding unnecessary fetch

### 4. Incremental efficiency ✅

- `syncEventActor()` uses the returned participant row directly
- No `findParticipants(...includeUnmatched)` fetch needed
- Avoids expensive "fetch all participants" in large chats

### 5. Identity scoping clarified ✅

- Identities are **global** (no family_id in identities table)
- One row per `(provider, provider_user_id)` across all families
- conversation_participants joins identity to family/conversation

### 6. Recency support (optional) ✅

- `isParticipant()` accepts optional `activeSince` parameter
- Enables "currently active" vs "ever participated" distinction
- Default behavior (no activeSince) is "ever participated" - safe for build/test

### 7. Matching discipline ✅

- Once `person_id` is linked, don't rematch (prevents thrashing)
- Explicit log when already linked
- Name matching is best-effort fallback (identity_id is source of truth)

### 8. Schema polish ✅

- `UNIQUE(family_id, conversation_id, identity_id)` prevents collisions
- Index on `person_id WHERE person_id IS NOT NULL` (partial index)
- Comments document invariants clearly
- identities uniqueness documented as prerequisite

### 9. Confidence threshold for auto-linking ✅

- Only auto-link if `matchReason === 'exact' | 'alias'` OR `confidence >= 0.9`
- Prevents silent mis-linking when there are multiple "David"s
- Low-confidence matches logged as warnings for manual review

### 10. Upsert clarity ✅

- Removed `ignoreDuplicates` (unclear behavior in PostgREST)
- Only `onConflict` needed - payload columns get updated

### 11. updated_at handling ✅

- Note added: either add auto-update trigger OR remove column (keep lean)
- Same applies to identities table

### 12. Family integrity guard ✅

- `linkParticipantToPerson()` verifies person belongs to same family_id
- Prevents catastrophic cross-family linking bugs
- Cheap check, high safety value

### 13. matchReason documentation ✅

- Comment added to adjust matchReason strings to match implementation
- Prevents silent breakage if enum values differ
- Example values documented: 'exact', 'alias', 'fuzzy'

---

## Summary & Implementation Priority

### Current Status

| Component                    | Status             | Action Required                         |
| ---------------------------- | ------------------ | --------------------------------------- |
| **Question Generation**      | ❌ Disabled        | None (dormant)                          |
| **Question Sending**         | ✅ Active          | Ready to send when questions exist      |
| **Participant Verification** | ❌ Not Implemented | Implement before re-enabling questions  |
| **Question Targeting**       | ❌ Not Implemented | Implement when building Historian agent |

### Implementation Phases

#### Phase 1: Participant Verification (URGENT when questions return)

**Implement BEFORE re-enabling question generation**

1. Add participant tracking (table or query-based approach)
2. Update Facilitator to check participation before addressing
3. Update prompt builder for strict allowlist
4. Add tests for verification logic

**Priority:** HIGH (prevents bug from activating)
**Effort:** Medium (2-3 days)
**Blocks:** Question generation re-enablement

#### Phase 2: Question Targeting (Implement with Historian)

**Implement DURING Historian agent development**

1. Define targeting rules in question generation logic
2. Add `questionType` field to questions schema
3. Implement `selectTargetPerson()` function
4. Test targeting strategy with real conversations

**Priority:** MEDIUM (improves question quality)
**Effort:** Medium (2-3 days)
**Blocks:** High-quality question generation

### Decision Points

1. **Table vs Query approach** for participant tracking
   - Recommendation: Start with query-based (simpler)
   - Upgrade to table if performance issues arise

2. **New members without messages**
   - Current: Message-based (conservative, only address after first message)
   - Alternative: Access-based (include all family_access members)

3. **Implementation timing**
   - Option A: Implement now (preemptive, safer)
   - Option B: Wait until questions return (defer work)
   - **Recommendation:** Option B (questions not needed yet)

### Files Affected

**Phase 1 (Participant Verification):**

- `libs/database/src/lib/repositories/participant-repository.ts` (new or query-based)
- `libs/agents/facilitator/src/lib/facilitator.ts` (add verification)
- `libs/agents/facilitator/src/lib/prompt-builder.ts` (strict allowlist)
- `libs/prompts/src/agents/facilitator.txt` (update instructions)

**Phase 2 (Question Targeting):**

- Future Historian agent question generation logic
- `libs/shared/types/src/lib/entities.ts` (add questionType field)
- Question generation tests

---

## Related Documents

- `docs/plans/2026-01-25-question-generation-future-work.md` - Why questions were disabled
- `docs/architecture/data-architecture.md` - Overall system architecture
- `apps/db/supabase/migrations/20260112074715_init_schema.sql` - Current database schema
