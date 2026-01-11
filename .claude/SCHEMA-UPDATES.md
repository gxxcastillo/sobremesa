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

---

## Pre-Deployment Checklist

- [ ] Create RLS policies as documented
- [ ] Test cascade deletes work correctly
- [ ] Verify triggers update timestamps
- [ ] Run schema against local Supabase

---

**Last Updated**: 2026-01-10
**Schema Version**: 1.0 (MVP)
