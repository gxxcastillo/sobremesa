# Persons System

## Overview

The **Persons system** represents real-world people in the family tree. It balances:

- **Complete information** when available (name, birth year, death year)
- **Incomplete information** when not yet discovered (placeholders)
- **Fuzzy matching** to find the same person mentioned in different ways
- **Merge capabilities** to combine incomplete data when real person is identified

---

## Architecture

```
Chat Messages
    ↓
Scribe extracts names
    ↓
PersonRepository searches for matches
    ├─ Found existing person → Update aliases
    ├─ Similar person → Fuzzy match confirms identity
    └─ New person → Create new record
    ↓
Person Record
├─ Identified people (name, aliases, birth year, death year)
└─ Placeholder people (for unknown intermediate people)
```

---

## Schema

### People Table

```sql
CREATE TABLE people (
  id UUID PRIMARY KEY,
  family_id UUID NOT NULL,

  -- Identity
  name VARCHAR(255) NOT NULL,
  aliases JSONB DEFAULT '[]',          -- JSON array of alternate names

  -- Derived summaries (from claims, not primary source)
  birth_year INTEGER,
  birth_year_confidence VARCHAR(20),   -- 'high', 'medium', 'low'
  death_year INTEGER,
  death_year_confidence VARCHAR(20),

  -- Placeholder flag
  is_placeholder BOOLEAN DEFAULT FALSE,

  -- Notes in original language
  notes_original TEXT,
  language_original VARCHAR(10),

  -- Provenance
  first_mentioned_event_id UUID,
  created_by VARCHAR(255),

  -- Privacy
  redacted BOOLEAN DEFAULT FALSE,
  redacted_at TIMESTAMPTZ,
  redacted_by VARCHAR(255),
  redaction_reason TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Key Fields

#### `name`

The primary name. Examples:

- "Gabriel Barreto"
- "Rosa María"
- "Unknown" (for placeholders)

#### `aliases`

Alternative names the person is known by (JSON array):

```json
["Gabe", "Gabriel", "Gab", "Gabriel Barreto"]
```

Updated as new mentions are found.

#### `birth_year` & `death_year`

Derived from claims, not primary source. Can be NULL if unknown.

#### `is_placeholder`

`true` if this is a placeholder person (unknown intermediate in family tree).

Examples:

- "Unknown parent of Maria"
- "Unknown spouse of Juan"
- "Unknown sibling's child"

#### `first_mentioned_event_id`

The conversation event that first mentioned this person.

---

## Fuzzy Matching

### How It Works

When Scribe extracts a person's name, PersonRepository searches:

```typescript
async findByFuzzyMatch(
  familyId: string,
  name: string,
  aliases: string[] = []
): Promise<Person | null>
```

**Search order:**

1. Exact matches (case-insensitive)
2. Similarity matches (Levenshtein distance > 0.8)

**Examples:**

| Search     | Found                  | Match Type         |
| ---------- | ---------------------- | ------------------ |
| "Gabriel"  | "Gabriel Barreto"      | Exact              |
| "Gabe"     | "Gabriel" (in aliases) | Exact              |
| "Gabriela" | "Gabriel"              | Similarity (typo?) |
| "José"     | "Jose" (in aliases)    | Exact              |

### Confidence

**High confidence:**

- Exact name match
- Name in existing aliases
- Very similar (Levenshtein > 0.95)

**Medium confidence:**

- Fuzzy match (0.8-0.95)

**Low confidence:**

- Common first names
- Multiple candidates
- Need manual review

---

## API Usage

### Creating Persons

#### Via Repository

```typescript
const personRepo = new PersonRepository();

// Create new person (from Scribe extraction)
const person = await personRepo.findOrCreate(
  familyId,
  {
    name: 'Gabriel Barreto',
    aliases: ['Gabe', 'Gabriel'],
    birthYear: 1985,
    confidence: Confidence.MEDIUM,
  },
  sourceEventId,
  createdBy
);
```

#### Auto-Creation on Message Ingestion

When Scribe processes a message, it creates Person records:

```typescript
async extractPeople(conversation: string): Promise<ExtractedPerson[]> {
  // Scribe AI extracts: "Gabriel told me..."
  return [
    {
      name: "Gabriel",
      aliases: [],
      birthYear: null,
      confidence: Confidence.MEDIUM
    }
  ];
}

// Registrar then:
for (const extracted of people) {
  const person = await personRepo.findOrCreate(
    familyId,
    extracted,
    sourceEventId
  );

  // If not found, creates new
  // If found, updates aliases
}
```

### Querying Persons

#### Find by Exact Name

```typescript
const person = await personRepo.findByName(familyId, 'Gabriel');
```

#### Find by Fuzzy Match

```typescript
// Search for Gabriel or his known aliases
const person = await personRepo.findByFuzzyMatch(familyId, 'Gabriel', [
  'Gabe',
  'Gabriel Barreto',
]);
```

#### Find All Active

```typescript
// Get all non-redacted people
const people = await personRepo.findAllActive(familyId);
```

### Updating Persons

#### Update Aliases

```typescript
// Add new aliases as we discover them
await personRepo.updateAliases(familyId, personId, [
  ...existingAliases,
  'NewAlias',
]);
```

---

## Placeholder Persons

### What Are Placeholders?

Placeholders represent **unknown people** in the family tree when we know a relationship exists:

```
"Maria's cousin exists, but we don't know their name"
→ Create placeholder
→ Create relationship: Maria → Placeholder
→ Link placeholder to Maria's cousin's relatives
→ Later, when we discover the name: merge placeholder into real person
```

### Creating Placeholders

#### Via Repository

```typescript
const personRepo = new PersonRepository();

// Create placeholder
const placeholder = await personRepo.createPlaceholder(
  familyId,
  'parent of Maria', // description
  [mariaPersonId], // related people
  sourceEventId,
  createdBy
);

// Returns Person with:
// - name: "Unknown"
// - isPlaceholder: true
// - aliases: ["parent of Maria", "related-to:maria-uuid"]
```

#### Find or Create Placeholder

```typescript
// Check if placeholder already exists
const placeholder = await personRepo.findOrCreatePlaceholder(
  familyId,
  'parent of Maria',
  [mariaPersonId],
  sourceEventId
);

// Returns existing if found, creates if not
```

#### Find Placeholder by Description

```typescript
// Check if we already have this placeholder
const existing = await personRepo.findPlaceholderByDescription(
  familyId,
  'parent of Maria'
);
```

### Merging Placeholders

When you discover who a placeholder actually is:

```typescript
const personRepo = new PersonRepository();

// 1. Create real person
const realPerson = await personRepo.insert({
  familyId,
  name: 'Juan García',
  aliases: [],
  // ... other fields
});

// 2. Merge placeholder into real person
await personRepo.mergePlaceholderIntoPerson(
  familyId,
  placeholderId,
  realPerson.id
);

// Result:
// - Placeholder is marked redacted (soft delete)
// - All relationships pointing to placeholder are updated (in transaction)
// - Real person now has all the relationships
```

---

## Design Decisions

### Why Store Derived Summaries?

Fields like `birth_year` and `death_year` are **derived from claims**, not primary source:

✅ **Benefits:**

- Quick lookup: "Who was born in 1950?"
- UI convenience: Don't need to query claims every time
- Performance: No join needed for basic queries

❌ **Trade-off:**

- **Redundant** - Real truth lives in claims table
- **Stale** - Need to update if conflicting claims emerge

**Solution:** Claims are the canonical source. These fields are cached summaries.

### Why Fuzzy Matching?

People are mentioned many ways:

| Mention     | Stored                  |
| ----------- | ----------------------- |
| "Gabriel"   | Gabriel Barreto         |
| "Gabe"      | Gabriel Barreto         |
| "Gabriela"  | Gabriel Barreto (typo?) |
| "José Luis" | J.L. or just "José"     |

Fuzzy matching prevents creating duplicate people for typos/nicknames.

### Why Placeholders?

Instead of forcing "Unknown" names, placeholders let us:

- Link relationships even with missing data
- Build partial family trees
- Merge later when real person identified
- Avoid orphaned relationship records

Example:

```
Maria and Pedro are cousins
But neither knows Pedro's grandfather's name
→ Create placeholder "grandfather of Pedro"
→ Relationship: Maria → [placeholder cousin] → Pedro
→ Later: discover grandfather's name, merge
```

---

## Common Workflows

### Workflow 1: Single Person Extracted

```
Scribe: "Gabriel says..."
  ↓
PersonRepository.findByFuzzyMatch("Gabriel", [])
  ↓
Not found
  ↓
PersonRepository.findOrCreate(
  {name: "Gabriel", aliases: [], ...},
  sourceEventId
)
  ↓
New Person created
```

### Workflow 2: Same Person, Multiple Ways

```
Message 1: "Gabriel told me..."
  → PersonRepository.findOrCreate("Gabriel", [])
  → New Person

Message 2: "Gabe said..."
  → PersonRepository.findByFuzzyMatch("Gabe", ["Gabe"])
  → Found! (Gabriel in aliases)
  → Update aliases if needed

Message 3: "Gabriel Barreto was saying..."
  → PersonRepository.findByFuzzyMatch("Gabriel Barreto", [])
  → Found! (matches "Gabriel")
  → Merge aliases: ["Gabe", "Gabriel Barreto"]
```

### Workflow 3: Placeholder for Unknown

```
Extracted: "Maria's cousin exists but unknown"
  → Need to store relationship
  → PersonRepository.findOrCreatePlaceholder(
      "cousin of Maria",
      [mariaPersonId]
    )
  → Placeholder created

Later: "Her name is Rosa García"
  → PersonRepository.findOrCreate("Rosa García", ...)
  → Real person created
  → PersonRepository.mergePlaceholderIntoPerson(
      placeholderId,
      realPersonId
    )
  → Placeholder redacted
  → Rosa now has all relationships
```

---

## Database Indexes

Optimized for common queries:

```sql
-- Search by name
CREATE INDEX idx_people_family_name
  ON people(family_id, name);

-- Exclude redacted people
CREATE INDEX idx_people_not_redacted
  ON people(family_id, redacted)
  WHERE redacted = FALSE;

-- Find placeholders
CREATE INDEX idx_people_placeholder
  ON people(family_id, is_placeholder)
  WHERE is_placeholder = TRUE;
```

---

## Levenshtein Similarity

The fuzzy matcher uses Levenshtein distance to find similar names:

```typescript
calculateSimilarity(a: string, b: string): number
```

Returns: 0 (completely different) to 1 (identical)

**Threshold:** 0.8 (80% similar)

**Examples:**

```
similarity("Gabriel", "Gabriel") = 1.0    ✓
similarity("Gabriel", "Gabriela") = 0.85  ✓
similarity("Gabriel", "Gabriel ") = 0.88  ✓
similarity("Gabriel", "Bob") = 0.0        ✗
```

---

## Related Documentation

- **Schema**: [20260112074715_init_schema.sql](../apps/db/supabase/migrations/20260112074715_init_schema.sql)
- **Repository**: [person-repository.ts](../libs/database/src/lib/repositories/person-repository.ts)
- **Types**: [entities.ts](../libs/shared/types/src/lib/entities.ts)
- **Relationships**: [RELATIONSHIPS.md](./RELATIONSHIPS.md)
- **Identities**: [IDENTITIES.md](./IDENTITIES.md)
- **Domain Model**: [DOMAIN-MODEL.md](./DOMAIN-MODEL.md)

---

**Last Updated**: 2026-01-12
**Status**: Production-ready with placeholder support
