# ADR-001: Family Tree Traversal Service

## Status

Proposed

## Context

The relationship model stores only **structural relationships**:

- `parent` (personA is parent, personB is child)
- `spouse` (normalized by UUID order)

Extended relationships like sibling, grandparent, cousin, aunt/uncle are **derived** by traversing the graph, not stored directly. This keeps the data normalized and avoids redundancy.

Currently, `RelationshipRepository` provides primitive queries:

- `findParents(personId)`
- `findChildren(personId)`
- `findSpouses(personId)`

But there's no logic to derive extended relationships.

## Decision

When needed, implement a `FamilyTreeService` that provides graph traversal to derive relationships.

### Proposed API

```typescript
interface FamilyTreeService {
  // Direct traversal
  findSiblings(familyId: string, personId: string): Promise<Person[]>;
  findHalfSiblings(familyId: string, personId: string): Promise<Person[]>;
  findGrandparents(familyId: string, personId: string): Promise<Person[]>;
  findGrandchildren(familyId: string, personId: string): Promise<Person[]>;
  findAuntsUncles(familyId: string, personId: string): Promise<Person[]>;
  findNiecesNephews(familyId: string, personId: string): Promise<Person[]>;
  findCousins(familyId: string, personId: string): Promise<Person[]>;
  findInLaws(familyId: string, personId: string): Promise<Person[]>;

  // Path finding
  findRelationshipPath(
    familyId: string,
    personAId: string,
    personBId: string
  ): Promise<RelationshipPath>;

  // Human-readable description
  describeRelationship(
    familyId: string,
    personAId: string,
    personBId: string
  ): Promise<string>;
}
```

### Traversal Definitions

| Relationship              | Traversal                                  |
| ------------------------- | ------------------------------------------ |
| Sibling                   | People who share at least one parent       |
| Half-sibling              | People who share exactly one parent        |
| Grandparent               | Parent's parent                            |
| Grandchild                | Child's child                              |
| Aunt/Uncle                | Parent's sibling                           |
| Niece/Nephew              | Sibling's child                            |
| Cousin                    | Parent's sibling's child                   |
| First cousin once removed | Parent's cousin's child, or cousin's child |
| Parent-in-law             | Spouse's parent                            |
| Child-in-law              | Child's spouse                             |
| Sibling-in-law            | Spouse's sibling, or sibling's spouse      |

### Implementation Considerations

1. **Caching**: For large family trees, cache traversal results
2. **Cycle detection**: Handle remarriage/step-relationships that could create cycles
3. **Qualifier awareness**: Consider `half`, `step`, `adoptive` qualifiers when computing relationships
4. **Performance**: Use breadth-first search with depth limits for distant relationships

## Consequences

### Positive

- Single source of truth for relationships (no denormalized cousin/sibling records)
- Correct handling of complex family structures (remarriage, half-siblings, step-relations)
- Human-readable relationship descriptions for UI

### Negative

- Traversal has computational cost vs. direct lookup
- Complex relationships (e.g., "first cousin twice removed") require careful implementation

### Risks

- May need database-level graph queries (recursive CTEs) for performance at scale

## References

- Relationship schema: `apps/db/supabase/migrations/20260112074715_init_schema.sql`
- RelationshipRepository: `libs/database/src/lib/repositories/relationship-repository.ts`
- Relationship types: `libs/shared/types/src/lib/entities.ts`
