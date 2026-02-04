# Configuration Guide

Complete guide to configuring Sobremesa for different families, languages, and cultures.

---

## Configuration Philosophy

Sobremesa is a **reusable library** designed to work for any family, in any language, with any cultural context.

**Internal code uses generic role names:**

- `BotRole.FACILITATOR`, `BotRole.ADMIN`, `BotRole.SCRIBE`

**Configuration provides:**

- Display names (what users see)
- Languages (primary + original preservation)
- Personalities (how bots behave)
- Cultural context (terms to preserve)

---

## Two Config Systems

There are two configuration interfaces in the codebase:

1. **`SobremesaConfig`** (`libs/shared/types/src/lib/config.ts`) - Complete system config including coaching, web3, and generic bot personality. Uses `BotPersonality` with formality/verbosity/emojiUsage/warmthLevel for all bots.

2. **`FamilyConfig`** (`libs/shared/types/src/lib/conversation.ts`) - What's actually stored in the `families` table `config` JSONB column. Uses `FamilyBotConfig` with per-bot personality types (facilitator has engagement/patience, admin has celebration, scribe has thoroughness).

The database-stored `FamilyConfig` is what drives runtime behavior. Check the source files above for current field definitions.

---

## 1. Project Identity

Each family has a `familyId` (UUID) and optional `projectName`.

**Examples:**

- Spanish family: `"Sobremesa"` (after-dinner conversation time)
- English family: `"Family Stories"`, `"Our History"`
- Japanese family: `"家族の記憶"` (Family Memories)

---

## 2. Language Configuration

**`FamilyConfig.languages`** has a `primary` field for bot response language.

Currently supported languages: `en`, `es`. The broader `LanguageConfig` type (used in `SobremesaConfig`) also supports `pt`, `fr`, `de` for content detection and has a `secondary` array.

**Storage:** Content is stored in its original language only.

- `content_original` - Exact words spoken (sacred, never modified)
- `language_original` - ISO code of original language

**Translation:** Generated on-read when needed, not pre-computed.

---

## 3. Bot Configuration

Each bot has a `displayName` and `personality` with bot-specific traits.

### Facilitator

Personality traits: formality, emojiUsage, engagement, verbosity, patience.

**Example:** "Carmencita" - friendly, moderate emoji, curious engagement

### Admin

Personality traits: formality, emojiUsage, celebration.

**Example:** "La Directora" - friendly, moderate emoji, enthusiastic celebration

### Scribe

Personality traits: thoroughness (essential / standard / comprehensive).

The scribe also has an internal `confidence` setting (strict / moderate / lenient) defined in `libs/agents/scribe/src/lib/types.ts`, separate from family config.

**Example:** "Don Rubén" - comprehensive thoroughness

### Historian

Has a `displayName` only (no personality config).

---

## 4. Cultural Terms

A list of words that are NEVER translated, just explained in parentheses.

**Example:**

```
Spanish: "Abuela hacía gallo pinto todos los domingos"
English: "Grandma made gallo pinto (rice and beans) every Sunday"
         ^ NOT translated, just explained
```

---

## Complete Configuration Examples

### Example 1: Nicaraguan Family (Default)

- Project name: "Sobremesa"
- Primary language: Spanish (`es`)
- Facilitator: "Carmencita" - friendly, moderate emoji, curious
- Admin: "La Directora" - friendly, moderate emoji, enthusiastic celebration
- Scribe: "Don Rubén" - comprehensive thoroughness
- Cultural terms: pulpería, gallo pinto, vigorón, nacatamal, fritanga, pinolillo

### Example 2: American English Family

- Project name: "Family Stories"
- Primary language: English (`en`)
- Facilitator: "Annie" - friendly, minimal emoji, curious
- Admin: "The Coordinator" - professional, minimal emoji, warm celebration
- Scribe: "The Archivist" - standard thoroughness
- Cultural terms: none

### Example 3: Japanese Family

- Project name: "家族の記憶"
- Primary language: Japanese (`ja`)
- Facilitator: "ゆい (Yui)" - formal, minimal emoji, gentle
- Admin: "管理者" - formal, no emoji, understated celebration
- Scribe: "記録者" - comprehensive thoroughness
- Cultural terms: おばあちゃん, おじいちゃん, 家族, 故郷

---

## How Config is Loaded

1. **Database-stored:** Config lives in the `families` table, `config` column (JSONB). Loaded via `FamilyRepository.findById()` or `findDefault()`.

2. **Config access:** Specific values can be read with `FamilyRepository.getConfigValue(id, path)` and updated with `FamilyRepository.updateConfigPath(id, path, value)`.

3. **Defaults:** New families start with empty config `{}`. Default values are defined in `DEFAULT_CONFIG` (config.ts) and `DEFAULT_SCRIBE_CONFIG` (scribe types).

---

## Summary

**Active configuration (FamilyConfig in database):**

- Project identity (familyId, projectName)
- Primary language
- Bot display names and personality traits (per-bot)
- Cultural terms list

**Defined in types but not actively used yet:**

- Coaching settings (evaluation interval, rate limits) — in `SobremesaConfig`
- Web3 integration (optional, off by default) — in `SobremesaConfig`

**Key principle:** Internal code is generic, configuration makes it specific to each family.
