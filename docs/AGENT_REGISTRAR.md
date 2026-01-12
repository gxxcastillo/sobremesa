
## 💾 Registrar (Backend)

### Role
Database gatekeeper - ONLY component that writes to core tables.

### Inputs
Domain models from Scribes (text and media).

### Responsibilities

1. **Schema Mapping** - Domain model → database schema
2. **Deduplication** - Check if entity exists (fuzzy matching)
3. **Claim Creation** - Store as claims, not facts
4. **Relationship Building** - Convert names → UUIDs
5. **Conflict Preservation** - Create conflict records
6. **Provenance Tracking** - Link to source messages
7. **Bilingual Storage** - Store original + translations
8. **Web3 Integration** - Optional blockchain writes

**Deduplication Scope (Hard Rule)**
Deduplication applies only to entity identity (e.g., the same person/place/event represented multiple ways). It must never merge, delete, or “choose” between competing claims. Conflicting claims are preserved and linked. Dedupe searches must only be within family_id.

### Process

```typescript
// IMPORTANT: dedupe entities only; never dedupe claims (preserve conflicts).
async process(domainModel: DomainModel): Promise<void> {
  // For each person
  for (const person of domainModel.people) {
    // 1. Check if exists (fuzzy matching)
    const existing = await this.findPerson(person.name, person.aliases);
    
    if (existing) {
      // Update (merge aliases, add relationships)
      await this.updatePerson(existing.id, person);
    } else {
      // Insert new
      await this.insertPerson(person);
    }
  }
  
  // For each claim
  for (const claim of domainModel.claims) {
    // 1. Check for conflicting claims
    const existingClaims = await this.findClaimsBySubject(claim.subject);
    
    const conflicts = existingClaims.filter(ec => 
      this.isConflicting(ec, claim)
    );
    
    if (conflicts.length > 0) {
      // Create claim with conflict links
      claim.conflicts_with = conflicts.map(c => c.id);
      
      // Update existing claims to point back
      for (const conflict of conflicts) {
        await this.addConflictLink(conflict.id, claim.id);
      }
    }
    
    // 2. Insert claim
    await this.insertClaim(claim);
  }
  
  // Optional: Web3 write
  if (config.web3Enabled) {
    const hash = this.hashContent(domainModel);
    await this.web3Hook.writeToSolana(hash);
  }
}
```

### Database Access

**Read:** All tables (needs to check for duplicates)

**Write:** All core tables (EXCLUSIVE access)

### Common Mistakes
- ❌ Allowing other components to write
- ❌ Auto-resolving conflicts
- ❌ Missing provenance
- ❌ Weak deduplication
- ❌ Skipping validation

---
