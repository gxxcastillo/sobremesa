# Data Isolation & Multi-Family Support

How Sobremesa ensures complete data isolation between families.

---

## Core Principle

**Every family's data is completely isolated.**

No family should ever see or access another family's messages, stories, people, questions, or any other data. This is a **security requirement**, not just organization.

---

## Implementation Strategy

### 1. Database-Level Isolation

**Every table MUST have `family_id` column:**

```sql
CREATE TABLE people (
  id UUID PRIMARY KEY,
  family_id UUID NOT NULL REFERENCES families(id),
  canonical_name VARCHAR(255),
  -- ... other columns
);

CREATE INDEX idx_people_family ON people(family_id);  -- Required for performance
```

**Every query MUST filter by `family_id`:**

```typescript
// ❌ WRONG - No family_id filter
const people = await db.from('people').select('*');

// ✅ CORRECT - Always filter by family_id
const people = await db.from('people').select('*').eq('family_id', familyId);
```

---

### 2. Row-Level Security (RLS)

**Enable RLS on all tables:**

```sql
ALTER TABLE people ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
-- ... enable on ALL tables with family_id
```

**Backend services use service role (bypasses RLS):**

```sql
CREATE POLICY "Service role bypass"
  ON people FOR ALL TO service_role
  USING (true) WITH CHECK (true);
```

**Client access (future) uses family-scoped policies:**

```sql
CREATE FUNCTION current_family_id() RETURNS UUID AS $$
  SELECT current_setting('app.current_family_id', true)::uuid;
$$ LANGUAGE sql STABLE;

CREATE POLICY "Family members see own data"
  ON people FOR SELECT
  USING (family_id = current_family_id());
```

---

### 3. Application-Level Safeguards

**Repository pattern enforces family_id:**

```typescript
class PersonRepository {
  async findById(familyId: string, personId: string): Promise<Person | null> {
    // ALWAYS include family_id in query
    const { data } = await this.db
      .from('people')
      .select('*')
      .eq('family_id', familyId)
      .eq('id', personId)
      .single();

    return data;
  }

  async create(familyId: string, person: CreatePersonInput): Promise<Person> {
    // ALWAYS set family_id on insert
    const { data } = await this.db
      .from('people')
      .insert({ ...person, family_id: familyId })
      .select()
      .single();

    return data;
  }
}
```

**Composite foreign keys include family_id:**

```sql
-- Ensure claim_entities links are scoped to same family
CREATE TABLE claim_entities (
  claim_id UUID NOT NULL,
  entity_id UUID NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  family_id UUID NOT NULL,

  FOREIGN KEY (family_id, claim_id) REFERENCES claims(family_id, id),
  FOREIGN KEY (family_id, entity_id) -- Reference to people/places/events
);
```

---

### 4. Deduplication Scoping

**Entity matching only within family:**

```typescript
class EntityMatcherService {
  async matchPerson(
    familyId: string,
    extractedPerson: Person,
    existingPeople: Person[],
  ): Promise<MatchResult> {
    // existingPeople already filtered by family_id
    // Never match across families

    const matches = existingPeople.filter((person) =>
      this.fuzzyMatch(extractedPerson.name, person.name),
    );

    return matches[0] || null;
  }
}
```

**Claim conflict detection scoped:**

```typescript
async function detectConflicts(familyId: string, newClaim: Claim) {
  // Only check conflicts within same family
  const existingClaims = await claimRepo.findBySubject(
    familyId, // ← Always pass family_id
    newClaim.subject,
  );

  return existingClaims.filter((c) => contradicts(c, newClaim));
}
```

---

### 5. Queue Isolation

**Processing queue includes family_id:**

```sql
CREATE TABLE processing_queue (
  id UUID PRIMARY KEY,
  family_id UUID NOT NULL,
  event_id UUID NOT NULL,
  status VARCHAR(20),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_queue_family_status
  ON processing_queue(family_id, status);
```

**Workers process by family:**

```typescript
async function processQueue() {
  // Dequeue items for ALL families, but track family_id
  const items = await queue.dequeue(10);

  for (const item of items) {
    // Pass family_id to all downstream operations
    await processEvent(item.family_id, item.event_id);
  }
}
```

---

### 6. Configuration Isolation

**Family-specific settings:**

```sql
CREATE TABLE family_config (
  family_id UUID PRIMARY KEY REFERENCES families(id),
  primary_language VARCHAR(10) DEFAULT 'es',
  secondary_language VARCHAR(10) DEFAULT 'en',
  bot_personality JSONB,
  facilitator_rules JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Load config by family:**

```typescript
async function getConfig(familyId: string): Promise<FamilyConfig> {
  return await db
    .from('family_config')
    .select('*')
    .eq('family_id', familyId)
    .single();
}
```

---

### 7. Event Log Isolation

**All events tagged with family_id:**

```typescript
async function logEvent(
  familyId: string,
  eventType: string,
  actor: string,
  eventData: any,
) {
  await db.from('event_log').insert({
    family_id: familyId, // ← Required
    event_type: eventType,
    actor,
    event_data: eventData,
    timestamp: new Date().toISOString(),
  });
}
```

**Query logs by family:**

```typescript
const logs = await db
  .from('event_log')
  .select('*')
  .eq('family_id', familyId)
  .order('timestamp', { ascending: false })
  .limit(100);
```

---

## Common Pitfalls to Avoid

**❌ Forgetting family_id in WHERE clause:**

```typescript
// WRONG - Leaks data across families
const person = await db.from('people').eq('id', personId).single();
```

**✅ Always include family_id:**

```typescript
const person = await db
  .from('people')
  .eq('family_id', familyId)
  .eq('id', personId)
  .single();
```

**❌ Using INNER JOIN without family_id:**

```sql
-- WRONG - Could join across families
SELECT c.*, p.name
FROM claims c
INNER JOIN people p ON c.person_id = p.id;
```

**✅ Include family_id in join condition:**

```sql
SELECT c.*, p.name
FROM claims c
INNER JOIN people p
  ON c.family_id = p.family_id
  AND c.person_id = p.id
WHERE c.family_id = $1;
```

**❌ Passing wrong family_id to repository:**

```typescript
// WRONG - Using family_id from one context in another
const familyA = 'uuid-a';
const personFromFamilyB = await personRepo.findById(familyA, personBId);
// Returns null (person doesn't exist in family A)
```

---

## Testing Multi-Family Isolation

**Test isolation in integration tests:**

```typescript
describe('Data Isolation', () => {
  it('should not see other families data', async () => {
    const familyA = await createFamily('Family A');
    const familyB = await createFamily('Family B');

    const personA = await personRepo.create(familyA.id, { name: 'Alice' });
    const personB = await personRepo.create(familyB.id, { name: 'Bob' });

    // Try to access Family B's person from Family A context
    const result = await personRepo.findById(familyA.id, personB.id);

    expect(result).toBeNull(); // Should not find it
  });

  it('should not deduplicate across families', async () => {
    const familyA = await createFamily('Family A');
    const familyB = await createFamily('Family B');

    // Same name in both families
    await personRepo.create(familyA.id, { name: 'Maria Garcia' });
    await personRepo.create(familyB.id, { name: 'Maria Garcia' });

    const peopleA = await personRepo.findAll(familyA.id);
    const peopleB = await personRepo.findAll(familyB.id);

    expect(peopleA).toHaveLength(1);
    expect(peopleB).toHaveLength(1);
    expect(peopleA[0].id).not.toBe(peopleB[0].id); // Different entities
  });
});
```

---

## Deployment Model

**Single database, multiple families:**

- All families share same Supabase project
- Isolation via `family_id` column + RLS
- Cost-effective for MVP (one database to manage)
- Scales to thousands of families

**Per-family databases (future):**

- For enterprise customers
- Complete physical isolation
- More expensive but highest security
- Requires federation layer

---

## Data Isolation Checklist

- [ ] All tables have `family_id` column
- [ ] All tables have index on `family_id`
- [ ] RLS enabled on all tables
- [ ] All queries filter by `family_id`
- [ ] Repositories enforce `family_id` in methods
- [ ] Foreign keys include `family_id` (composite keys)
- [ ] Deduplication only within family
- [ ] Queue items include `family_id`
- [ ] Event logs include `family_id`
- [ ] Configuration scoped by `family_id`
- [ ] Integration tests verify isolation
- [ ] No queries bypass `family_id` filter

---

## See Also

- [ARCHITECTURE.md](ARCHITECTURE.md) - System architecture
- [AUTH.md](AUTH.md) - Family-scoped access control
- [DATA-MODELS.md](DATA-MODELS.md) - Database schema
