# People and Roles

**How Sobremesa separates chat accounts, web users, family members, and access control.**

---

## Core Concepts

Sobremesa distinguishes between several related but separate concepts:

| Concept           | Table           | Scope      | Purpose                                                 |
| ----------------- | --------------- | ---------- | ------------------------------------------------------- |
| **Person**        | `people`        | Per-family | Record in the family genealogy (the "real person")      |
| **Identity**      | `identities`    | Global     | Chat provider account (Telegram user, WhatsApp contact) |
| **User**          | `users`         | Global     | Web auth account for Studio login                       |
| **Family Access** | `family_access` | Per-family | Permission to access a family with a role               |
| **Participant**   | (query-based)   | Contextual | Someone who has sent messages AND claimed a person      |

### Relationship Chain

```
User (web auth account)
  └── Identity (provider account, e.g., Telegram)
        └── Family Access (per-family permission)
              ├── role: admin | member | viewer
              └── person_id → Person (genealogy record)
```

---

## People (Family Genealogy)

**People** are records in the family tree representing real-world humans.

**Key attributes:**

- Name and aliases (nicknames, alternate spellings)
- Birth/death years (derived from claims)
- Placeholder flag (for unknown family members)

**Fuzzy matching:** When names are extracted, Sobremesa uses fuzzy matching to avoid creating duplicates:

- Exact name matches
- Alias matches
- Similar names (Levenshtein distance > 0.8)

**Example:** "Donald", "Don", and "Donald Barreto" all match to the same person.

**Placeholders:** When a relationship exists but the person's name is unknown:

- Create placeholder: "parent of Maria"
- Can be merged later when the real name is discovered
- Prevents orphaned relationships

---

## Identities (Chat Accounts)

**Identities** represent chat provider accounts.

**Separation from people:**

- Same person can have multiple identities (Telegram + WhatsApp)
- Identity can exist without linking to a person (guests, bot-only)
- Profile info (display name, username) auto-updates from provider

**Providers:** Telegram, WhatsApp, SMS, others as needed

**Linking:** Identities are linked to people via `family_access.person_id`

**Example flow:**

1. Donald sends message in Telegram → Identity created
2. Donald logs into Studio → User created, linked to identity
3. Donald claims "I'm Donald" → `family_access.person_id` set

---

## Users (Web Authentication)

**Users** are web authentication accounts for Studio login.

**Authentication methods:**

- Telegram Login Widget (OAuth-like flow with Telegram)
- Access Pass (one-time token from bot command)

**Global roles:**

- `user` - Regular user
- `super_admin` - Bypass all permission checks, see all families

**Relationship to identities:**

- One user can have multiple identities (same person, different chat accounts)
- An identity may exist without a user (bot-only interaction, no web login)

---

## Family Access (Permissions)

**Family Access** controls who can access which family and what they can do.

**Family-scoped roles:**

- `admin` - Manage family data, grant access, view events
- `member` - View and edit family data
- `viewer` - Read-only access

**Status workflow:**

- `pending` - Invited but not yet accepted
- `active` - Currently has access
- `revoked` - Access removed
- `suspended` - Temporarily disabled

**Person claim:** Each family access record can claim a `person_id`, linking the identity to a specific person in that family's genealogy.

**Key insight:** Same identity can theoretically claim different people in different families (useful for historians working with multiple families).

---

## Participants (Query-Based)

**Participants** are not a table but a query concept: someone who has:

1. Sent messages in the conversation (checked via `conversation_events`)
2. Claimed a person in the family (checked via `family_access.person_id`)

**Used by:** Facilitator to determine who can be addressed in conversations.

**Example:**

```
Facilitator asks: "Is Donald a participant?"
→ Check: Has Donald's identity sent messages? ✓
→ Check: Does Donald's family_access have person_id? ✓
→ Result: Yes, Donald is a verified participant
```

---

## Why These Separations?

### Identity vs Person

**Benefits:**

- Flexibility: One person, multiple chat accounts
- Decoupling: Accept messages without knowing real identity
- Multi-channel: Same family member on Telegram, WhatsApp, SMS
- Privacy: "Guest" identities not linked to family tree

### User vs Identity

**Benefits:**

- Web login separate from chat interaction
- Not everyone who chats needs web access
- Clean separation of authentication concerns

### Family Access

**Benefits:**

- Fine-grained permissions per family
- Same person, different roles in different families
- Audit trail for access grants/revocations
- Person claims scoped by family

---

## Common Scenarios

### Single Channel User

```
1. Donald sends message in Telegram
   → Identity: telegram:123456789
2. Donald logs into Studio
   → User created, linked to identity
3. Donald claims person in family
   → family_access.person_id = donald_person_id
4. Donald is now a verified participant
```

### Multi-Channel User

```
1. Donald uses Telegram → Identity: telegram:123456789
2. Donald also uses WhatsApp → Identity: whatsapp:5511999999999
3. Both identities linked to same user
4. Both family_access records point to same person_id
5. Facilitator sees unified history across channels
```

### Guest (Unlinked)

```
1. Someone joins group chat, sends message
2. Identity created but not linked to user
3. No family_access.person_id (not claimed)
4. Messages processed but not a participant
5. Cannot be addressed by Facilitator
```

### Placeholder Evolution

```
1. Extract: "Maria's cousin exists but unknown"
2. Create placeholder person: "cousin of Maria"
3. Later discover: "Her name is Rosa García"
4. Create real person: "Rosa García"
5. Merge placeholder into real person
6. All relationships preserved
```

---

## See Also

- [AUTH.md](AUTH.md) - JWT authentication and access control
- [DATA-ISOLATION.md](DATA-ISOLATION.md) - Family-scoped data model
- [DATA-MODELS.md](DATA-MODELS.md) - Database schema details
