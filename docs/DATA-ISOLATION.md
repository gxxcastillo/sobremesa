# Data Isolation & Multi-Family Support

How Sobremesa ensures complete data isolation between families.

---

## Core Principle

**Every family's data is completely isolated.**

No family should ever see or access another family's messages, stories, people, or any data. This is a **security requirement**, not just organization.

---

## Implementation Strategy

### Database-Level Isolation

**Every table has `family_id` column:**

- All tables reference `families(id)`
- Indexed for performance
- Required in all queries and inserts

**Every query filters by `family_id`:**

- No cross-family data leaks
- Composite foreign keys include `family_id`
- JOINs enforce family scoping

### Row-Level Security (RLS)

**All tables have RLS enabled:**

- Backend uses service role (bypasses RLS with explicit family_id filtering)
- Future client access uses family-scoped policies
- Session-based family context for user queries

### Application-Level Safeguards

**Repository pattern enforces family_id:**

- All methods require `family_id` parameter
- Find operations filter by family
- Insert operations set `family_id`
- Prevents accidental cross-family access

### Scoped Operations

**Entity matching:** Only within same family (never match across families)

**Conflict detection:** Only check claims within same family

**Processing queue:** Items include `family_id`, workers track family context

**Configuration:** Family-specific settings (language, bot personality, rules)

**Event logs:** All events tagged with `family_id`

---

## Common Pitfalls

**Missing family_id filter:** Always include `family_id` in WHERE clauses

**Wrong family_id in JOINs:** Include `family_id` in join conditions

**Context confusion:** Pass correct `family_id` through all operations

---

## Testing

**Integration tests verify:**

- Families cannot access each other's data
- Deduplication stays within family boundaries
- Same names in different families create separate entities

---

## Deployment Model

**Current:** Single database with `family_id` isolation (cost-effective, scales to thousands)

**Future:** Per-family databases for enterprise (physical isolation, requires federation)

---

## See Also

- [ARCHITECTURE.md](ARCHITECTURE.md) - System architecture
- [AUTH.md](AUTH.md) - Family-scoped access control
- [DATA-MODELS.md](DATA-MODELS.md) - Database schema
