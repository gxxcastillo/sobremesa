# Identities System

## Overview

The **Identities system** bridges chat providers (Telegram, WhatsApp, SMS) with the family tree. It separates **provider accounts** from **real-world people**, allowing multiple chat identities to link to a single person in your family tree.

---

## Architecture

```
Telegram User (ID: 123456789)
    ↓
Identity Record (provider_user_id: "123456789")
    ↓
Person Record (name: "Gabriel")
    ├── Other Telegram accounts
    ├── WhatsApp account  
    └── SMS contact
```

### Key Insight

A **person** (real-world human) can have **multiple identities**:
- Same person with different Telegram accounts
- Same person via Telegram + WhatsApp
- Same person across multiple chat channels

---

## Schema

### Identities Table

```sql
CREATE TABLE identities (
  id UUID PRIMARY KEY,
  family_id UUID NOT NULL,
  
  -- Provider account
  source VARCHAR(50) NOT NULL,         -- 'telegram', 'whatsapp', 'sms'
  provider_user_id VARCHAR(255) NOT NULL,  -- e.g., Telegram user ID (string)
  
  -- Profile snapshot (read from provider)
  display_name VARCHAR(255),           -- Latest known name from provider
  username VARCHAR(255),               -- Latest known username from provider
  
  -- Link to family tree person
  person_id UUID NULL,                 -- Optional: link to canonical Person
  
  is_active BOOLEAN DEFAULT TRUE,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE (family_id, source, provider_user_id),
  CONSTRAINT fk_identities_person_family
    FOREIGN KEY (family_id, person_id)
    REFERENCES people(family_id, id)
    ON DELETE SET NULL
);
```

### Key Fields

#### `source`
The chat provider:
- `'telegram'` - Telegram
- `'whatsapp'` - WhatsApp
- `'sms'` - SMS
- Others as needed

#### `provider_user_id`
The unique identifier on the provider:
- For Telegram: `from.id` as string (e.g., `"123456789"`)
- For WhatsApp: JID (e.g., `"5511999999999@c.us"`)
- For SMS: Phone number

#### `display_name` & `username`
Latest known profile info from the provider. **Updated automatically** if the user changes their profile:

```typescript
// If Telegram user changes display_name, it auto-updates
await identityRepo.findOrCreate(
  familyId,
  'telegram',
  '123456789',
  'Gabriel Updated Name',  // Changed
  '@gabriel_new'           // Changed
);
// → Updates existing identity with new names
```

#### `person_id`
Optional link to the canonical `Person` in the family tree. Can be:
- `NULL` - Identity not yet linked to a real person
- UUID - Linked to a specific person

**Linking is not automatic** - done manually or via coaching:
```typescript
await identityRepo.linkToPerson(familyId, identityId, personId);
```

---

## API Usage

### Creating Identities

#### Via Repository

```typescript
const identityRepo = new IdentityRepository();

// Create or update identity (idempotent)
const identity = await identityRepo.findOrCreate(
  familyId,
  'telegram',
  String(telegramUserId),
  firstNameAndLastName,
  telegramUsername
);

// Returns existing identity if already created
// Updates display_name/username if changed
```

#### Auto-Creation on Message Ingestion

In the message ingester, identities are created automatically:

```typescript
async ingestTextMessage(ctx: TextMessageContext) {
  const msg = ctx.message;
  
  // Auto-create identity
  await this.identityRepo.findOrCreate(
    this.familyId,
    'telegram',
    String(msg.from.id),
    this.getDisplayName(msg.from),
    msg.from.username
  );
  
  // Then ingest the message...
}
```

### Querying Identities

#### Lookup by Provider

```typescript
// Find identity by provider user ID
const identity = await identityRepo.findByProviderUserId(
  familyId,
  'telegram',
  '123456789'
);
```

#### Lookup by Person

```typescript
// Find all identities for a person
const identities = await identityRepo.findByPersonId(familyId, personId);

// Returns all chat accounts linked to this person
// Example:
// [
//   {id: "...", source: "telegram", provider_user_id: "123456789", ...},
//   {id: "...", source: "whatsapp", provider_user_id: "5511999999999@c.us", ...}
// ]
```

#### Find All Active

```typescript
// Get all active identities for a family
const identities = await identityRepo.findAllActive(familyId);
```

### Linking to People

#### Link Identity to Person

```typescript
// Link Telegram identity to Gabriel
await identityRepo.linkToPerson(
  familyId,
  identityId,
  gabrielPersonId
);

// Now queries for Gabriel's identities return this one
```

#### Unlink Identity from Person

```typescript
// Remove link (identity stays, just person_id becomes NULL)
await identityRepo.unlinkFromPerson(familyId, identityId);
```

---

## Common Workflows

### Workflow 1: New Chat User

```
1. User sends first message in Telegram group
2. MessageIngester auto-creates Identity record
   - source: 'telegram'
   - provider_user_id: (Telegram ID)
   - display_name: (from Telegram profile)
   - person_id: NULL (not linked yet)
3. User is recognized in future messages
4. (Optional) Admin links identity to existing Person
   - "This is Gabriel!"
   - identity.person_id = gabriel_person_id
```

### Workflow 2: Same Person, Multiple Channels

```
1. Gabriel chats via Telegram
   - Identity created: telegram:123456789
2. Gabriel also has WhatsApp
   - Identity created: whatsapp:5511999999999@c.us
3. Admin links both to same Person
   - Both identities.person_id = gabriel_person_id
4. Facilitator knows all messages from either account are Gabriel
5. Unified history for Gabriel across channels
```

### Workflow 3: Profile Update

```
1. Gabriel changes Telegram display name: "Gabriel" → "Gabe"
2. Next message arrives
3. findOrCreate detects display_name changed
4. Auto-updates identity record
5. No manual action needed
```

### Workflow 4: New Device, Same Account

```
1. Gabriel logs into Telegram on new phone
2. Telegram ID remains the same: 123456789
3. findOrCreate finds existing identity
4. Returns existing record (no duplicate)
```

---

## Design Decisions

### Why Separate Identity from Person?

✅ **Benefits:**
- **Flexibility** - One person can have multiple chat accounts
- **Decoupling** - Don't need to know real name to accept messages
- **Multi-channel** - Same family tree person on Telegram, WhatsApp, SMS
- **Privacy** - Can have "Guest" identities not linked to family tree
- **Audit** - Tracks all provider accounts used by each family

❌ **Trade-off:**
- **Linking complexity** - Must explicitly link identity → person

### Why Not Merge Identity with Person?

If identity fields were directly on `people` table:
- Hard to have multiple chat accounts
- Can't add new chat providers without schema changes
- Identity updates could collide (username changes)
- Privacy/access harder to control

### Why Auto-Update Profile Fields?

Telegram users frequently change:
- Display name
- Username
- Profile picture

Storing latest snapshot means:
- Facilitator can address user correctly
- Event log reflects current state
- No stale profile data

---

## Security Considerations

### RLS (Row Level Security)

Identities table should enforce family isolation:

```sql
-- Only team members can see identities for their family
CREATE POLICY "family_isolation_select" ON identities
  FOR SELECT
  USING (family_id IN (
    SELECT family_id FROM user_families WHERE user_id = auth.uid()
  ));
```

### Sensitive Data

⚠️ **Provider user IDs are identifiers**, treat as sensitive:
- Don't log full provider_user_id publicly
- Use family_id + identity_id references in audit logs
- Encrypt at rest if needed

---

## Database Indexes

Optimized for common queries:

```sql
-- Lookup by provider
CREATE INDEX idx_identities_family_source_user
  ON identities(family_id, source, provider_user_id);

-- Lookup by person
CREATE INDEX idx_identities_family_person
  ON identities(family_id, person_id)
  WHERE person_id IS NOT NULL;
```

---

## Example Scenarios

### Scenario 1: Single Account, Single Person

```
Chat Message
├─ Telegram from: 123456789
├─ Display name: "Gabriel Barreto"
└─ Username: "@gabriel_dev"

Identity Created
├─ source: 'telegram'
├─ provider_user_id: '123456789'
├─ display_name: 'Gabriel Barreto'
├─ username: '@gabriel_dev'
└─ person_id: NULL (not linked)

Person Created (from Scribe)
├─ name: 'Gabriel'
└─ aliases: ['Gabe', 'Gabriel Barreto']

[Admin links identity → person]

Identity Updated
└─ person_id: gabriel_person_id
```

### Scenario 2: Same Person, Multiple Channels

```
User sends to Telegram → Identity: telegram:123456789
User sends via WhatsApp → Identity: whatsapp:5511999999999@c.us
User sends via SMS → Identity: sms:+5511999999999

[Admin realizes it's the same person]

Link both identities to Person: gabriel_person_id

Now:
- All three identities.person_id = gabriel_person_id
- Facilitator can track messages from all three channels
- Single unified history for Gabriel
```

### Scenario 3: Unlinked Guest

```
Someone joins group chat, sends one message
Identity created: telegram:999999999
person_id: NULL (not in family tree)

[Group discusses - not family member]

Identity remains unlinked indefinitely
Messages still processed, but not attributed to a family member
```

---

## Related Documentation

- **Schema**: [20260112074715_init_schema.sql](../apps/db/supabase/migrations/20260112074715_init_schema.sql)
- **Repository**: [identity-repository.ts](../libs/database/src/lib/repositories/identity-repository.ts)
- **Types**: [conversation.ts](../libs/shared/types/src/lib/conversation.ts)
- **Message Ingestion**: [ingester.ts](../apps/conversation-gateway/src/bot/ingester.ts)
- **Relationships**: [RELATIONSHIPS.md](./RELATIONSHIPS.md)
- **Persons**: [PERSONS.md](./PERSONS.md)

---

**Last Updated**: 2026-01-12
**Status**: Production-ready
