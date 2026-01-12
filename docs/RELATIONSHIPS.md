# Relationships System

## Overview

The Sobremesa relationships system is built on a **structural graph model** where only essential relationship types are stored directly in the database. Extended relationships (siblings, grandparents, cousins, etc.) are **derived** through graph traversal.

---

## Core Model

### Structural Types (Stored Directly)

Only two relationship types form the **backbone** of the family tree:

| Type | Definition | Storage |
|------|-----------|---------|
| **parent** | `personA` is the parent, `personB` is the child | Direct |
| **spouse** | Two people in a committed relationship | Direct (normalized by UUID) |

All other relationships (sibling, grandparent, cousin, aunt/uncle, etc.) are **computed** via graph traversal.

### Extended Types (Derived)

These are calculated on-demand from structural relationships:

- **Sibling** - People who share at least one parent
- **Half-sibling** - People who share exactly one parent
- **Grandparent** - Parent's parent
- **Grandchild** - Child's child
- **Aunt/Uncle** - Parent's sibling
- **Niece/Nephew** - Sibling's child
- **Cousin** - Parent's sibling's child
- **Parent-in-law** - Spouse's parent
- **Child-in-law** - Child's spouse
- **Sibling-in-law** - Spouse's sibling or sibling's spouse

---

## Schema

### Relationships Table

```sql
CREATE TABLE relationships (
  id UUID PRIMARY KEY,
  family_id UUID NOT NULL,
  
  person_a_id UUID NOT NULL,
  person_b_id UUID NOT NULL,
  
  relationship_type VARCHAR(50) NOT NULL,  -- 'parent', 'spouse', 'guardian', etc.
  category VARCHAR(20) DEFAULT 'biological',  -- biological, legal, functional, honorary, social
  status VARCHAR(20) DEFAULT 'active',        -- active, ended, deceased
  qualifier VARCHAR(30),                      -- half, step, adoptive, maternal, paternal, etc.
  
  confidence VARCHAR(20) DEFAULT 'medium',
  source_event_id UUID,
  claimed_by VARCHAR(255),
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Key Fields

#### `relationship_type`
The type of relationship. Examples:
- Structural: `'parent'`, `'spouse'`
- Extended narrative: `'guardian'`, `'godparent'`, `'mentor'`, `'friend'`, `'caregiver'`

#### `category`
Distinguishes the **nature** of the relationship:
- `'biological'` - Blood relations
- `'legal'` - Adoption, marriage, legal guardianship
- `'functional'` - Raised by, de facto guardian
- `'honorary'` - Godparent, "uncle" by respect, padrino (godfather)
- `'social'` - Family friend, mentor, best friend

#### `status`
Lifecycle state of the relationship:
- `'active'` - Currently active
- `'ended'` - Divorced, separated, estranged
- `'deceased'` - Ended due to death

#### `qualifier`
Nuance for the relationship:
- `'half'` - Half-brother, half-sister
- `'step'` - Step-parent, step-sibling
- `'adoptive'` - Adoptive parent
- `'maternal'` - Maternal grandfather
- `'paternal'` - Paternal grandmother
- Others as context requires

---

## Normalization Rules

The system automatically normalizes relationships for consistent storage:

### Rule 1: Parent Relationships
```typescript
// Input: (childId, parentId, 'child')
// Stored as: (parentId, childId, 'parent')
normalizeRelationship(childId, parentId, 'child')
// → {personAId: parentId, personBId: childId, relationshipType: 'parent'}
```

### Rule 2: Symmetric Relationships (Spouse, Friend)
```typescript
// Input: (person1Id, person2Id, 'spouse')
// Stored with consistent order (lower UUID first):
normalizeRelationship(person1Id, person2Id, 'spouse')
// → {personAId: lower_uuid, personBId: higher_uuid, relationshipType: 'spouse'}
```

### Rule 3: Asymmetric Relationships
```typescript
// Input: (godparentId, godchildId, 'godparent')
// Stored as-is: personA is role-holder, personB is recipient
normalizeRelationship(godparentId, godchildId, 'godparent')
// → {personAId: godparentId, personBId: godchildId, relationshipType: 'godparent'}
```

---

## API Usage

### Creating Relationships

#### Via Repository

```typescript
const relationshipRepo = new RelationshipRepository();

// Create parent-child relationship
await relationshipRepo.findOrCreate(
  familyId,
  parentId,
  childId,
  'parent',
  {
    category: 'biological',
    status: 'active',
    confidence: Confidence.HIGH,
    sourceEventId: eventId,
    claimedBy: 'Gabriel'
  }
);

// Create spouse relationship (order-independent)
await relationshipRepo.findOrCreate(
  familyId,
  spouse1Id,
  spouse2Id,
  'spouse',
  {
    category: 'legal',
    status: 'active',
    qualifier: 'divorced',  // optional
    sourceEventId: eventId
  }
);

// Create step-parent relationship
await relationshipRepo.findOrCreate(
  familyId,
  stepparentId,
  childId,
  'parent',
  {
    category: 'legal',
    qualifier: 'step',
    sourceEventId: eventId
  }
);
```

### Querying Relationships

#### Direct Lookups

```typescript
// Find all relationships for a person
const rels = await relationshipRepo.findByPerson(familyId, personId);

// Find relationship between two specific people
const rel = await relationshipRepo.findBetween(familyId, personAId, personBId);

// Get relationships by category
const biologicalRels = await relationshipRepo.findByCategory(
  familyId,
  'biological'
);

// Get structural relationships (for family tree)
const treeRels = await relationshipRepo.findTreeRelationships(familyId);

// Get a person's parents
const parents = await relationshipRepo.findParents(familyId, personId);

// Get a person's children
const children = await relationshipRepo.findChildren(familyId, personId);

// Get a person's spouses
const spouses = await relationshipRepo.findSpouses(familyId, personId);
```

#### Perspective-Aware Queries

```typescript
// Get relationships from a person's perspective
const perspective = await relationshipRepo.findByPersonWithPerspective(
  familyId,
  personId
);

// Returns: {
//   relationship: {...},
//   toPersonId: "...",
//   perspectiveType: "child" (if stored as parent relationship)
// }[]
```

---

## Derived Relationships (Future)

When needed, implement graph traversal service:

```typescript
interface FamilyTreeService {
  // Direct queries
  findSiblings(familyId: string, personId: string): Promise<Person[]>;
  findHalfSiblings(familyId: string, personId: string): Promise<Person[]>;
  findGrandparents(familyId: string, personId: string): Promise<Person[]>;
  findAuntsUncles(familyId: string, personId: string): Promise<Person[]>;
  findCousins(familyId: string, personId: string): Promise<Person[]>;
  
  // Path finding
  findRelationshipPath(
    familyId: string,
    personAId: string,
    personBId: string
  ): Promise<RelationshipPath>;
  
  // Human-readable
  describeRelationship(
    familyId: string,
    personAId: string,
    personBId: string
  ): Promise<string>;  // e.g., "first cousin twice removed"
}
```

---

## Design Decisions

### Why Only Store Parent + Spouse?

✅ **Benefits:**
- **Single source of truth** - No denormalized duplicate records
- **Handles complex families** - Remarriage, step-relations, multiple parents
- **Scalable** - Works for 10 people or 10,000 without denormalization
- **Audit trail** - Every explicit relationship is tracked with provenance

❌ **Trade-off:**
- **Computation** - Deriving extended relationships requires graph traversal
- **Complexity** - Need careful handling of qualifiers (half, step, adoptive)

### Why Categories + Status + Qualifiers?

The system preserves **nuance** that a simple type string cannot:

```typescript
// Example: Step-grandfather who is legally adopted
{
  relationshipType: 'parent',
  category: 'legal',      // Legal relationship (not biological)
  qualifier: 'step',      // Step-relationship
  status: 'active'
}

// Example: Deceased aunt (not stored as sibling, but relationship preserved)
{
  relationshipType: 'parent',  // Parent's parent
  category: 'biological',
  status: 'deceased'           // Status tracks end reason
}
```

### Why Normalize?

Normalization prevents duplicate/contradictory relationships:

```typescript
// Without normalization, could store both:
(personA, personB, 'parent')
(personB, personA, 'child')     // Confusing! Same relationship twice

// With normalization, always stored as:
(personA, personB, 'parent')    // Only one canonical form
```

---

## Implementation Details

### Normalization Logic

See [relationships.ts](../libs/shared/types/src/lib/relationships.ts):

```typescript
export function normalizeRelationship(
  personAId: string,
  personBId: string,
  relationshipType: string,
  category?: RelationshipCategory
): NormalizedRelationship
```

Features:
- Handles 'child' input by converting to 'parent' with swapped order
- Orders symmetric types (spouse, friend) by UUID
- Preserves asymmetric order (godparent stays as-is)
- Defaults categories based on type

### Perspective Functions

See [relationships.ts](../libs/shared/types/src/lib/relationships.ts):

```typescript
export function getRelationshipPerspective(
  personAId: string,
  personBId: string,
  relationshipType: string,
  fromPersonId: string
): { toPersonId: string; relationshipType: string }
```

Automatically computes inverse relationships:
- Parent → Child
- Guardian → Ward
- Godparent → Godchild
- Mentor → Mentee

---

## Database Constraints

The schema enforces data integrity:

```sql
-- Prevent self-relationships
CONSTRAINT no_self_relationship CHECK (person_a_id != person_b_id),

-- Validate category values
CONSTRAINT relationships_category_check 
  CHECK (category IN ('biological', 'legal', 'functional', 'honorary', 'social')),

-- Validate status values
CONSTRAINT relationships_status_check 
  CHECK (status IN ('active', 'ended', 'deceased'))
```

---

## Indexes

Optimized for common queries:

```sql
-- All relationships for a family
CREATE INDEX idx_relationships_family ON relationships(family_id);

-- Relationships involving specific people
CREATE INDEX idx_relationships_person_a ON relationships(family_id, person_a_id);
CREATE INDEX idx_relationships_person_b ON relationships(family_id, person_b_id);

-- Category queries (for biological tree, etc.)
CREATE INDEX idx_relationships_category ON relationships(family_id, category);

-- Structural relationships only (efficient tree traversal)
CREATE INDEX idx_relationships_tree ON relationships(family_id, category)
  WHERE category IN ('biological', 'legal');
```

---

## Example Scenarios

### Scenario 1: Basic Family

```
Gabriel = Rosa (spouse)
  ├─ Carmen (child)
  ├─ Manuel (child)
```

**Relationships stored:**
```
1. (Gabriel, Rosa, 'spouse', biological→legal)
2. (Gabriel, Carmen, 'parent', biological)
3. (Gabriel, Manuel, 'parent', biological)
4. (Rosa, Carmen, 'parent', biological)
5. (Rosa, Manuel, 'parent', biological)
```

**Derived:** Carmen and Manuel are siblings (share both parents)

### Scenario 2: Remarriage with Step-Relations

```
Juan = Maria
  ├─ Pedro

Maria = Carlos
  ├─ Pedro
  ├─ Sofia (child with Carlos)
```

**Relationships stored:**
```
1. (Juan, Maria, 'spouse')
2. (Juan, Pedro, 'parent')
3. (Maria, Pedro, 'parent')
4. (Maria, Carlos, 'spouse', status='ended')
5. (Carlos, Pedro, 'parent', qualifier='step')
6. (Carlos, Sofia, 'parent')
7. (Maria, Sofia, 'parent')
```

**Derived:** Pedro and Sofia are half-siblings (share only Maria as parent)

### Scenario 3: Unknown People (Placeholders)

When we know a relationship but not the intermediate person:

```
Carmen's cousin's child exists,
but we don't know Carmen's cousin's name
```

**Solution:** Create a placeholder person:
- Name: "Unknown"
- isPlaceholder: true
- aliases: ["parent of Carmen's cousin", "related-to:person-uuid"]

Then create relationship to the placeholder, which can later be merged when the real person is discovered.

---

## Related Documentation

- **Schema**: [20260112074715_init_schema.sql](../apps/db/supabase/migrations/20260112074715_init_schema.sql)
- **Repository**: [relationship-repository.ts](../libs/database/src/lib/repositories/relationship-repository.ts)
- **Types**: [entities.ts](../libs/shared/types/src/lib/entities.ts) + [relationships.ts](../libs/shared/types/src/lib/relationships.ts)
- **ADR**: [001-family-tree-traversal.md](./adr/001-family-tree-traversal.md)
- **Identities**: [IDENTITIES.md](./IDENTITIES.md) (for linking chat users to family tree)
- **Placeholder People**: [PERSONS.md](./PERSONS.md) (for handling unknown individuals)

---

**Last Updated**: 2026-01-12
**Status**: Complete with identity & placeholder support
