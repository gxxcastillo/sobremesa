# Data Isolation & Multi-Family Support

How Sobremesa ensures complete data isolation between families.

---

## Core Principle

**Every family's data is completely isolated.**

No family should EVER see or access another family's:
- Messages
- Stories
- People
- Questions
- Any other data

This is a **security requirement**, not just organization.

---

## Implementation Strategy

### 1. Database-Level Isolation

**Every table MUST have `family_id` column:**

```sql
CREATE TABLE people (
  id UUID PRIMARY KEY,
  family_id UUID NOT NULL REFERENCES families(id),  -- ← REQUIRED
  canonical_name VARCHAR(255),
  -- ... other columns
);

CREATE INDEX idx_people_family ON people(family_id);  -- ← REQUIRED
```

**Every query MUST filter by `family_id`:**

```typescript
// ❌ WRONG - No family_id filter
const people = await db.from('people').select('*');

// ✅ CORRECT - Always filter by family_id
const people = await db
  .from('people')
  .select('*')
  .eq('family_id', familyId);
```

---

## 2. Row-Level Security (RLS)

**Enforce isolation at database level using Supabase RLS.**

### Enable RLS on All Tables

```sql
-- Enable RLS
ALTER TABLE people ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE stories ENABLE ROW LEVEL SECURITY;
-- ... enable on ALL tables with family_id
```

### Create RLS Policies

**Option 1: Service Role (Backend Only)**

For backend services (bot, agents):

```sql
-- Service role can access all families (for multi-family backend)
CREATE POLICY "Service role bypass"
  ON people
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
```

**Option 2: Family-Scoped Access (If using anon key)**

If you expose database directly to clients (future dashboard):

```sql
-- Create function to get current family context
CREATE OR REPLACE FUNCTION current_family_id()
RETURNS UUID AS $$
  SELECT current_setting('app.current_family_id', true)::uuid;
$$ LANGUAGE sql STABLE;

-- Policy: Only access your own family's data
CREATE POLICY "Family members see own data"
  ON people
  FOR SELECT
  USING (family_id = current_family_id());

CREATE POLICY "Family members insert own data"
  ON people
  FOR INSERT
  WITH CHECK (family_id = current_family_id());

-- Set family context before queries
SET app.current_family_id = 'family-uuid-here';
```

---

## 3. Application-Level Safeguards

### Repository Pattern

**All data access MUST go through repositories that enforce family scoping:**

```typescript
// libs/database/src/lib/repositories/base-repository.ts
export abstract class BaseRepository<T> {
  protected familyId: string;
  
  constructor(protected db: SupabaseClient, familyId: string) {
    if (!familyId) {
      throw new Error('family_id is required for all database operations');
    }
    this.familyId = familyId;
  }
  
  protected scopeToFamily<Q>(query: Q): Q {
    // Automatically add family_id filter to all queries
    return query.eq('family_id', this.familyId);
  }
}

// Usage in specific repository
export class PeopleRepository extends BaseRepository<Person> {
  async findAll(): Promise<Person[]> {
    const query = this.db.from('people').select('*');
    const scopedQuery = this.scopeToFamily(query);
    const { data, error } = await scopedQuery;
    
    if (error) throw error;
    return data;
  }
  
  async create(person: CreatePerson): Promise<Person> {
    // Force family_id on create
    const personWithFamily = {
      ...person,
      family_id: this.familyId,  // ← Injected automatically
    };
    
    const { data, error } = await this.db
      .from('people')
      .insert(personWithFamily)
      .select()
      .single();
    
    if (error) throw error;
    return data;
  }
}
```

### Family Context Management

**Establish family context early in request lifecycle:**

```typescript
// apps/chatbots/src/main.ts
bot.on('message', async (msg) => {
  // 1. Determine family_id from message
  const familyId = await getFamilyIdFromChatId(msg.chat.id);
  
  if (!familyId) {
    logger.error({ chatId: msg.chat.id }, 'No family_id for chat');
    return;
  }
  
  // 2. Create family-scoped context
  const context = new FamilyContext(familyId);
  
  // 3. Pass to all services
  await processMessage(msg, context);
});

class FamilyContext {
  constructor(public readonly familyId: string) {
    if (!familyId) {
      throw new Error('family_id is required');
    }
  }
  
  // Create family-scoped repositories
  createPeopleRepo(db: SupabaseClient): PeopleRepository {
    return new PeopleRepository(db, this.familyId);
  }
  
  createClaimsRepo(db: SupabaseClient): ClaimsRepository {
    return new ClaimsRepository(db, this.familyId);
  }
  
  // ... other repositories
}
```

---

## 4. Deduplication Scoping

**CRITICAL: Deduplication MUST be scoped to family.**

```typescript
// ❌ WRONG - Deduplication across all families
async function findPersonByName(name: string): Promise<Person | null> {
  return db
    .from('people')
    .select('*')
    .ilike('canonical_name', name)
    .single();
}

// ✅ CORRECT - Deduplication within family only
async function findPersonByName(
  familyId: string,
  name: string
): Promise<Person | null> {
  return db
    .from('people')
    .select('*')
    .eq('family_id', familyId)        // ← Scope to family FIRST
    .ilike('canonical_name', name)
    .single();
}
```

**Why this matters:**

Two families might have people with same name:
- Family A: "María García" (Nicaraguan family)
- Family B: "María García" (Spanish family)

These are DIFFERENT people and must NOT be deduplicated together.

---

## 5. Queue Isolation

**Message queues MUST be family-scoped:**

```typescript
// Per-family queues
class MessageQueue {
  private queues: Map<string, string[]> = new Map();
  
  async enqueue(familyId: string, messageId: string) {
    const familyQueue = this.queues.get(familyId) || [];
    familyQueue.push(messageId);
    this.queues.set(familyId, familyQueue);
  }
  
  async dequeue(familyId: string): Promise<string | null> {
    const familyQueue = this.queues.get(familyId);
    if (!familyQueue || familyQueue.length === 0) return null;
    
    return familyQueue.shift() || null;
  }
  
  async getQueueDepth(familyId: string): Promise<number> {
    const familyQueue = this.queues.get(familyId);
    return familyQueue?.length || 0;
  }
}
```

**Why separate queues:**
- Different families process messages independently
- One busy family doesn't block another family's messages
- Fair processing across families

---

## 6. Configuration Isolation

**Each family has separate configuration:**

```typescript
// Load config for specific family
async function loadFamilyConfig(familyId: string): Promise<SobremesaConfig> {
  const { data, error } = await db
    .from('families')
    .select('config')
    .eq('id', familyId)
    .single();
  
  if (error) throw error;
  
  return validateConfig(data.config);
}
```

**Families can have:**
- Different languages (one Spanish/English, another Japanese/English)
- Different bot names ("Carmencita" vs "Annie" vs "Yui")
- Different personalities
- Different engagement rules

---

## 7. Event Log Isolation

**Event log MUST be family-scoped:**

```sql
-- Event log has family_id
CREATE TABLE event_log (
  id UUID PRIMARY KEY,
  family_id UUID NOT NULL REFERENCES families(id),
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  event_type VARCHAR(50),
  actor VARCHAR(255),
  event_data JSONB
);

CREATE INDEX idx_event_log_family_timestamp 
  ON event_log(family_id, timestamp DESC);
```

**Queries always filtered:**

```typescript
async function getRecentEvents(familyId: string, limit: number = 50) {
  return db
    .from('event_log')
    .select('*')
    .eq('family_id', familyId)  // ← REQUIRED
    .order('timestamp', { ascending: false })
    .limit(limit);
}
```

---

## 8. Coaching Rule Isolation

**Coaching adjustments apply to ONE family only:**

```sql
CREATE TABLE facilitator_rules (
  id UUID PRIMARY KEY,
  family_id UUID NOT NULL REFERENCES families(id),  -- ← One rule set per family
  max_questions_per_window INTEGER,
  current_signal VARCHAR(20),
  -- ...
);

CREATE TABLE real_time_levers (
  id UUID PRIMARY KEY,
  family_id UUID NOT NULL REFERENCES families(id),  -- ← One lever set per family
  active_conversation_cooldown_minutes INTEGER,
  -- ...
);
```

**Why this matters:**

Family A might need `hold_back` signal (they ignore questions).
Family B might need `jump_in` signal (they respond eagerly).

These adjustments MUST NOT affect each other.

---

## 9. Testing Multi-Family Isolation

**Test scenarios:**

### Test 1: Cross-Family Query Prevention

```typescript
test('cannot query another family\'s data', async () => {
  const familyA = 'family-a-uuid';
  const familyB = 'family-b-uuid';
  
  // Create person in Family A
  const personA = await peopleRepoA.create({
    canonicalName: 'María García',
  });
  
  // Try to find from Family B context
  const peopleRepoB = new PeopleRepository(db, familyB);
  const found = await peopleRepoB.findByName('María García');
  
  // Should NOT find Family A's person
  expect(found).toBeNull();
});
```

### Test 2: Deduplication Isolation

```typescript
test('deduplication scoped to family', async () => {
  const familyA = 'family-a-uuid';
  const familyB = 'family-b-uuid';
  
  // Create "María García" in both families
  const mariaA = await peopleRepoA.create({ canonicalName: 'María García' });
  const mariaB = await peopleRepoB.create({ canonicalName: 'María García' });
  
  // Should be different UUIDs
  expect(mariaA.id).not.toBe(mariaB.id);
  
  // Each family should only see their own
  const peopleA = await peopleRepoA.findAll();
  const peopleB = await peopleRepoB.findAll();
  
  expect(peopleA).toHaveLength(1);
  expect(peopleB).toHaveLength(1);
  expect(peopleA[0].id).toBe(mariaA.id);
  expect(peopleB[0].id).toBe(mariaB.id);
});
```

### Test 3: Queue Isolation

```typescript
test('message queues isolated per family', async () => {
  const familyA = 'family-a-uuid';
  const familyB = 'family-b-uuid';
  
  // Enqueue messages for both families
  await queue.enqueue(familyA, 'msg-a1');
  await queue.enqueue(familyB, 'msg-b1');
  await queue.enqueue(familyA, 'msg-a2');
  
  // Dequeue for Family A
  const msgA1 = await queue.dequeue(familyA);
  expect(msgA1).toBe('msg-a1');
  
  // Family B queue unaffected
  const msgB1 = await queue.dequeue(familyB);
  expect(msgB1).toBe('msg-b1');
  
  // Family A has second message
  const msgA2 = await queue.dequeue(familyA);
  expect(msgA2).toBe('msg-a2');
});
```

---

## 10. Common Pitfalls to Avoid

### ❌ Pitfall 1: Global State

```typescript
// BAD - Global people cache across all families
const peopleCache = new Map<string, Person>();

// GOOD - Family-scoped cache
const peopleCacheByFamily = new Map<string, Map<string, Person>>();
```

### ❌ Pitfall 2: Missing family_id in WHERE

```typescript
// BAD - Claims query without family_id
const claims = await db
  .from('claims')
  .select('*')
  .eq('subject', 'Rafael García');

// GOOD - Always include family_id
const claims = await db
  .from('claims')
  .select('*')
  .eq('family_id', familyId)
  .eq('subject', 'Rafael García');
```

### ❌ Pitfall 3: Cross-Family Conflict Detection

```typescript
// BAD - Detecting conflicts across all families
async function findConflictingClaims(claim: Claim) {
  return db
    .from('claims')
    .select('*')
    .eq('claim_type', claim.claim_type)
    .eq('subject', claim.subject)
    .neq('claim_value', claim.claim_value);
}

// GOOD - Conflicts only within family
async function findConflictingClaims(familyId: string, claim: Claim) {
  return db
    .from('claims')
    .select('*')
    .eq('family_id', familyId)  // ← REQUIRED
    .eq('claim_type', claim.claim_type)
    .eq('subject', claim.subject)
    .neq('claim_value', claim.claim_value);
}
```

---

## 11. Deployment Model

**Decision:** One bot instance per family (see ADR-024)

```bash
# Family A bot
FAMILY_ID=family-a-uuid npm start

# Family B bot (separate instance)
FAMILY_ID=family-b-uuid npm start
```

**Why this approach:**
- Complete isolation (separate processes)
- Bugs in one instance can't affect other families
- Easy to scale per family
- Simpler code (no multi-tenant routing logic)
- Family-specific config in env vars

**Trade-off:** More infrastructure (one instance per family), but isolation and simplicity outweigh this cost.

---

## 12. Checklist for Data Isolation

**Before deploying:**

- [ ] All tables have `family_id` column
- [ ] All tables have `family_id` index
- [ ] RLS enabled on all tables
- [ ] RLS policies created
- [ ] All repositories extend BaseRepository
- [ ] All queries filter by `family_id`
- [ ] Deduplication scoped to family
- [ ] Queue system scoped to family
- [ ] Configuration loaded per family
- [ ] Event log scoped to family
- [ ] Coaching rules scoped to family
- [ ] Cross-family tests pass
- [ ] Manual isolation audit complete

---

## 13. Isolation Audit Script

```typescript
// scripts/audit-isolation.ts
async function auditDataIsolation() {
  const issues: string[] = [];
  
  // Check all tables have family_id
  const tables = await getTableList();
  for (const table of tables) {
    const columns = await getTableColumns(table);
    if (!columns.includes('family_id') && table !== 'families') {
      issues.push(`Table ${table} missing family_id column`);
    }
  }
  
  // Check all queries in codebase
  const files = await glob('libs/**/*.ts');
  for (const file of files) {
    const content = await readFile(file, 'utf-8');
    const queries = extractSupabaseQueries(content);
    
    for (const query of queries) {
      if (!query.includes('.eq(\'family_id\'') && 
          !query.includes('families')) {
        issues.push(`Query in ${file} missing family_id filter`);
      }
    }
  }
  
  if (issues.length > 0) {
    console.error('Data isolation issues found:');
    issues.forEach(issue => console.error(`  - ${issue}`));
    process.exit(1);
  }
  
  console.log('✅ Data isolation audit passed');
}
```

Run before deploying:
```bash
npm run audit:isolation
```

---

## Summary

**Golden Rules:**

1. **Every table** has `family_id`
2. **Every query** filters by `family_id`
3. **Every repository** is family-scoped
4. **Deduplication** is family-scoped
5. **Queues** are family-scoped
6. **Coaching** is family-scoped
7. **Test** cross-family isolation
8. **Audit** before deploying
