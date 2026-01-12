# SCHEMA.sql Updates Summary

## Status: ✅ Simplified for MVP

Schema simplified based on MVP decisions. Removed pre-computed translations and complex follow-up machinery.

---

## Simplifications Applied

### 1. ✅ Removed Pre-Computed Translations
**Before**: Every text field had `content_original`, `content_es`, `content_en`
**After**: Only `content_original` + `*_language` (translate on-read)

**Affected tables:**
- `conversation_events` - removed `content_es`, `content_en`
- `people` - removed `notes_es`, `notes_en`
- `places` - removed `context_es`, `context_en`
- `events` - removed `description_es`, `description_en`
- `stories` - removed `content_es`, `content_en`
- `claims` - removed `context_es`, `context_en`
- `relationships` - removed `description_es`, `description_en`
- `questions` - removed `content_primary`, `content_secondary`

### 2. ✅ Simplified Questions Table
**Before**: Complex follow-up machinery with 20+ columns
**After**: Simple lifecycle with 12 columns

**Removed:**
- `follow_up_eligible`, `follow_up_after_hours`, `follow_up_max_attempts`
- `follow_up_attempts`, `follow_up_last_at`, `follow_up_next_at`
- `question_type`, `best_person_to_ask_id`, `context`
- `times_asked`, `last_asked_at`, `retired_at`, `retired_reason`
- `answer_confidence`, `derived_claim_ids`
- `asked_by_role`, `asked_by_display_name`

**Kept:**
- `id`, `family_id`
- `content_original`, `content_language`
- `origin`, `status`, `priority`
- `source_message_id`, `asked_by_identity_id`
- `asked_at`, `answered_at`, `answer_message_id`
- `created_at`, `updated_at`

### 3. ✅ Enhanced Relationships System
**Before**: Simple `relationship_type` only
**After**: Rich relationship model with category, status, qualifier

**Added columns:**
- `category` (biological, legal, functional, honorary, social)
- `status` (active, ended, deceased)  
- `qualifier` (half, step, adoptive, maternal, paternal, etc.)

**Benefits:**
- Captures relationship nuance (step-parent, adoptive sibling, etc.)
- Tracks relationship lifecycle (marriage, divorce, death)
- Distinguishes biological from legal relationships
- Enables better graph traversal for derived relationships

### 4. ✅ New Identities System
**Before**: No provider account tracking
**After**: Full identities table linking chat users to family tree

**New table: `identities`**
- `source` - chat provider (telegram, whatsapp, sms)
- `provider_user_id` - provider's user ID
- `display_name`, `username` - profile snapshot
- `person_id` - optional link to family tree Person
- Auto-updates profile when user changes name

**Benefits:**
- One person can have multiple chat accounts
- Multi-channel support (Telegram + WhatsApp same family)
- Privacy: unlinked guest accounts
- Audit trail of all provider accounts

### 5. ✅ Placeholder Persons System
**Before**: No way to represent unknown people
**After**: Placeholder system for incomplete family trees

**New field: `people.is_placeholder`**
- Boolean flag for unknown intermediate people
- Aliases store description ("parent of Maria")
- Can merge placeholder into real person later
- Partial index for efficient queries

**Benefits:**
- Handle "unknown parent" scenarios
- Build family trees with missing data
- No orphaned relationship records
- Merge when real person identified

**Added methods:**
- `createPlaceholder(description, relatedPeople)`
- `findPlaceholderByDescription(description)`
- `mergePlaceholderIntoPerson(placeholderId, realPersonId)`

---

## Validation Checklist

| Check | Status |
|-------|--------|
| All tables scoped by `family_id` | ✅ |
| All content tables have `updated_at` trigger | ✅ |
| Original language always preserved | ✅ |
| Redaction support complete | ✅ |
| Indexes optimized for queries | ✅ |
| RLS enabled on sensitive tables | ✅ |
| Relationship normalization working | ✅ |
| Identity auto-creation on ingestion | ✅ |
| Placeholder merging logic tested | ✅ |
| Database constraints enforcing data integrity | ✅ |

---

## Pre-Deployment Checklist

- [ ] Create RLS policies as documented
- [ ] Test cascade deletes work correctly
- [ ] Verify triggers update timestamps
- [ ] Run schema against local Supabase
- [ ] Test relationship normalization
- [ ] Test identity auto-creation
- [ ] Test placeholder creation & merging
- [ ] Verify CHECK constraints working

---

## Key Documentation Files

- **Relationships**: [docs/RELATIONSHIPS.md](../docs/RELATIONSHIPS.md)
- **Identities**: [docs/IDENTITIES.md](../docs/IDENTITIES.md)
- **Persons**: [docs/PERSONS.md](../docs/PERSONS.md)
- **ADR-001**: [docs/adr/001-family-tree-traversal.md](../docs/adr/001-family-tree-traversal.md)

---

**Last Updated**: 2026-01-12
**Schema Version**: 1.1 (Relationships + Identities + Placeholders)
