# Data Models Overview

## Quick Navigation

### Core Systems

1. **[Relationships](./RELATIONSHIPS.md)** - How people are connected

   - Structural model (parent, spouse only)
   - Derived relationships (siblings, cousins via graph traversal)
   - Category/status/qualifier for relationship nuance
   - Normalization rules for consistent storage

2. **[Identities](./IDENTITIES.md)** - Chat provider accounts

   - Maps Telegram/WhatsApp/SMS to family tree persons
   - Separates provider accounts from real people
   - One person can have multiple chat identities
   - Auto-updates profile snapshots

3. **[Persons](./PERSONS.md)** - Family tree members
   - Real people in the family tree
   - Fuzzy matching to find duplicates
   - Placeholder support for unknown people
   - Merge placeholders when real person identified

---

## Architecture

```
Chat Messages
    ↓
┌───────────────────────────────────────┐
│ MessageIngester (Bot)                 │
├───────────────────────────────────────┤
│ 1. Auto-create Identity for sender    │
│    - source: 'telegram'               │
│    - provider_user_id: "123456"       │
│    - person_id: NULL (not linked)     │
│                                       │
│ 2. Create ConversationEvent           │
│    - Record raw message               │
│    - Link to Identity                 │
│                                       │
│ 3. Enqueue for Scribe processing      │
└───────────────────────────────────────┘
    ↓
┌───────────────────────────────────────┐
│ Scribe (LLM Agent)                    │
├───────────────────────────────────────┤
│ 1. Extract persons mentioned          │
│ 2. Find/create Person records         │
│    - Fuzzy match against existing     │
│    - Create placeholders if needed    │
│                                       │
│ 3. Extract relationships              │
│    - Parent/spouse (store directly)   │
│    - Extended (derive from graph)     │
│                                       │
│ 4. Create DomainModel (JSON)          │
└───────────────────────────────────────┘
    ↓
┌───────────────────────────────────────┐
│ Registrar (Data Persistence)          │
├───────────────────────────────────────┤
│ 1. Deduplicate persons (fuzzy)        │
│ 2. Create/update relationships        │
│    - Normalize (parent/spouse)        │
│    - Apply category/qualifier         │
│                                       │
│ 3. Persist claims with provenance     │
│ 4. Log all changes                    │
│ 5. Create audit trail                 │
└───────────────────────────────────────┘
    ↓
Database (Supabase PostgreSQL)
```

---

## Data Flow Example

### Family Event: "Gabriel's cousin Rosa arrived from Argentina"

**Step 1: Chat Message → Identity**

```
Message: "Gabriel's cousin Rosa arrived from Argentina"
Source: Telegram (ID: 123456789)
From: @gabriel_dev (first_name: Gabriel)

→ MessageIngester.findOrCreate()
→ Identity created/updated:
   {
     source: 'telegram',
     provider_user_id: '123456789',
     display_name: 'Gabriel',
     username: '@gabriel_dev',
     person_id: NULL
   }
```

**Step 2: Scribe Extraction → Persons & Relationships**

```
Scribe processes: "Gabriel's cousin Rosa arrived"

→ Extract persons:
  - "Gabriel" → PersonRepository.findByFuzzyMatch()
    → Found in system

  - "Rosa" → New person
    → PersonRepository.create({
        name: 'Rosa',
        aliases: ['Rosa'],
        birthYear: null,
        is_placeholder: false
      })

→ Extract relationship:
  - Gabriel + Rosa are cousins
  - Scribe records: (Gabriel, Rosa, 'cousin')
    → But 'cousin' is DERIVED, not stored
    → Registrar derives from structural rels

→ DomainModel output:
  {
    people: [
      {name: 'Gabriel', aliases: [], ...},
      {name: 'Rosa', aliases: [], ...}
    ],
    relationships: [
      {personAName: 'Gabriel', personBName: 'Rosa', 'cousin', 'functional'}
    ]
  }
```

**Step 3: Registrar Persistence**

```
Registrar receives DomainModel

→ For each person:
  - PersonRepository.findByFuzzyMatch()
  - Create or merge with existing

→ For each relationship:
  - RelationshipRepository.findOrCreate()
    - Gabriel ↔ Rosa don't have stored relationship
    - Need to find structural path (via parents/spouses)
    - If no path: create placeholder for missing people
    - OR record narrative relationship (functional category)

→ Create relationships:
  {
    personAId: gabriel_id,
    personBId: rosa_id,
    relationshipType: 'cousin',      ← narrative
    category: 'functional',
    status: 'active',
    sourceEventId: message_id,
    claimedBy: 'Gabriel'
  }

→ Link identity to person:
  - Identity.person_id = gabriel_id
  - Now facilitator knows this Telegram user is Gabriel
```

**Result:**

- ✅ Gabriel's Telegram identity linked to family tree
- ✅ Rosa added to family tree
- ✅ Relationship recorded with full provenance
- ✅ Facilitator can address Gabriel by name
- ✅ Can query Rosa's relationships, ask her follow-up questions

---

## Key Concepts

### Normalization

Relationships stored in a canonical form to prevent duplicates:

```typescript
// Input: (personB, personA, 'child')
// Stored as: (personA, personB, 'parent')

normalizeRelationship(personB, personA, 'child')
→ {personAId: personA, personBId: personB, relationshipType: 'parent'}
```

### Perspectives

Relationships can be viewed from either person's perspective:

```typescript
// Stored: (Gabriel, Rosa, 'parent')

// From Gabriel's perspective:
{toPersonId: rosa_id, relationshipType: 'parent'}

// From Rosa's perspective:
{toPersonId: gabriel_id, relationshipType: 'child'}

// Computed by getRelationshipPerspective()
```

### Categories

Distinguish **nature** of relationship:

```typescript
{
  relationshipType: 'parent',
  category: 'biological',    // Blood relation
  qualifier: 'step'          // Step-parent
}

{
  relationshipType: 'parent',
  category: 'legal',         // Legal relationship
  qualifier: 'adoptive'      // Adoptive parent
}
```

### Placeholders

For unknown people in the family tree:

```typescript
// Extracted: "Maria has an unknown cousin"
// Create placeholder:
{
  name: 'Unknown',
  isPlaceholder: true,
  aliases: ['cousin of Maria', 'related-to:maria-uuid']
}

// Later: discover name is "Rosa García"
// Merge placeholder → real person
{
  name: 'Rosa García',
  isPlaceholder: false,
  aliases: ['cousin of Maria', 'Rosa García']
}
```

---

## Common Queries

### "Who is sending messages from Telegram?"

```sql
SELECT i.display_name, p.name
FROM identities i
LEFT JOIN people p ON i.person_id = p.id
WHERE i.source = 'telegram'
  AND i.family_id = ?
  AND i.is_active = TRUE
ORDER BY i.display_name;
```

### "What's Gabriel's relationship to Rosa?"

```sql
SELECT *
FROM relationships
WHERE family_id = ?
  AND ((person_a_id = gabriel_id AND person_b_id = rosa_id)
    OR (person_a_id = rosa_id AND person_b_id = gabriel_id))
```

### "Who are Gabriel's parents?"

```sql
SELECT p.*
FROM relationships r
JOIN people p ON r.person_a_id = p.id
WHERE r.family_id = ?
  AND r.person_b_id = gabriel_id
  AND r.relationship_type = 'parent'
  AND r.status = 'active'
```

### "Who are Gabriel's children?"

```sql
SELECT p.*
FROM relationships r
JOIN people p ON r.person_b_id = p.id
WHERE r.family_id = ?
  AND r.person_a_id = gabriel_id
  AND r.relationship_type = 'parent'
  AND r.status = 'active'
```

### "Find all placeholders"

```sql
SELECT *
FROM people
WHERE family_id = ?
  AND is_placeholder = TRUE
  AND redacted = FALSE
ORDER BY updated_at DESC
```

---

## Database Schema

All tables are scoped by `family_id` for multi-tenancy:

```
families (top-level tenant)
├── people
├── relationships
├── identities
├── conversation_events
├── claims
├── stories
├── events
├── places
├── images
├── questions
├── event_log (audit trail)
├── processing_queue
├── facilitator_rules
├── real_time_levers
└── facilitator_performance
```

**Multi-tenancy guarantees:**

- Each family isolated
- No cross-family queries
- RLS policies enforce family boundaries
- All foreign keys include family_id

---

## Audit Trail

Every change is logged in `event_log`:

```sql
INSERT INTO event_log (
  family_id,
  event_type,
  event_category,
  actor,
  event_data,
  source_event_id
) VALUES (
  ?,
  'event_ingested',
  'user_action',
  'Gabriel',
  {'messageType': 'text', 'textLength': 250},
  conversation_event_id
);
```

---

## Related ADRs & Decisions

- **ADR-001**: [Family Tree Traversal Service](./adr/001-family-tree-traversal.md) - How to derive extended relationships
- **Architecture**: [ARCHITECTURE.md](./ARCHITECTURE.md) - System design overview
- **Schema Updates**: [.claude/SCHEMA-UPDATES.md](../.claude/SCHEMA-UPDATES.md) - Recent schema changes

---

## Implementation Progress

| Feature                             | Status | File                                                                                           |
| ----------------------------------- | ------ | ---------------------------------------------------------------------------------------------- |
| Relationships table                 | ✅     | [init_schema.sql](../apps/db/supabase/migrations/20260112074715_init_schema.sql)               |
| Relationship normalization          | ✅     | [relationships.ts](../libs/shared/types/src/lib/relationships.ts)                              |
| RelationshipRepository              | ✅     | [relationship-repository.ts](../libs/database/src/lib/repositories/relationship-repository.ts) |
| Identities table                    | ✅     | [init_schema.sql](../apps/db/supabase/migrations/20260112074715_init_schema.sql)               |
| IdentityRepository                  | ✅     | [identity-repository.ts](../libs/database/src/lib/repositories/identity-repository.ts)         |
| Auto-create identities on ingestion | ✅     | [ingester.ts](../apps/chatbots/src/bot/ingester.ts)                                            |
| Placeholder persons                 | ✅     | [person-repository.ts](../libs/database/src/lib/repositories/person-repository.ts)             |
| Placeholder merging                 | ✅     | [person-repository.ts](../libs/database/src/lib/repositories/person-repository.ts)             |
| Fuzzy matching                      | ✅     | [person-repository.ts](../libs/database/src/lib/repositories/person-repository.ts)             |
| FamilyTreeService (derivation)      | ⏳     | TBD                                                                                            |

---

**Last Updated**: 2026-01-12
**Status**: Relationships, Identities, and Placeholder systems complete
