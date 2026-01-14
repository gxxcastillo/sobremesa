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

## Complete Configuration Interface

```typescript
interface SobremesaConfig {
  // === Project Identity ===
  familyId: string;
  projectName: string;

  // === Languages ===
  languages: {
    primary: string; // ISO code: "es", "en", "ja"
  };

  // === Bot Configuration ===
  bots: {
    facilitator: FacilitatorConfig;
    admin: AdminConfig;
    scribe: ScribeConfig;
  };

  // === Cultural Context ===
  culturalTerms: string[];
}
```

---

## 1. Project Identity

```typescript
{
  familyId: "uuid-here",
  projectName: "Sobremesa"
}
```

**Examples:**

- Spanish family: `"Sobremesa"` (after-dinner conversation time)
- English family: `"Family Stories"`, `"Our History"`
- Japanese family: `"家族の記憶"` (Family Memories)

---

## 2. Language Configuration

```typescript
{
  languages: {
    primary: 'es';
  }
}
```

### How It Works

**Storage:** Content is stored in its original language only.

- `content_original` - Exact words spoken (sacred, never modified)
- `language_original` - ISO code of original language

**Translation:** Generated on-read when needed, not pre-computed.

**Supported languages:** Any language Claude supports (`es`, `en`, `ja`, `zh`, `fr`, `de`, etc.)

---

## 3. Bot Configuration

### Facilitator Configuration

```typescript
interface FacilitatorConfig {
  displayName: string;

  personality: {
    formality: 'casual' | 'friendly' | 'professional' | 'formal';
    emojiUsage: 'none' | 'minimal' | 'moderate' | 'generous';
    engagement: 'gentle' | 'curious' | 'enthusiastic';
  };
}
```

**Example Configurations:**

```typescript
// Nicaraguan family (Carmencita)
{
  displayName: "Carmencita",
  personality: {
    formality: 'friendly',
    emojiUsage: 'moderate',
    engagement: 'curious'
  }
}

// Conservative American family
{
  displayName: "Annie",
  personality: {
    formality: 'professional',
    emojiUsage: 'minimal',
    engagement: 'gentle'
  }
}

// Japanese family (formal)
{
  displayName: "ゆい (Yui)",
  personality: {
    formality: 'formal',
    emojiUsage: 'minimal',
    engagement: 'gentle'
  }
}
```

**Personality Trait Guide:**

| Trait          | Options                                | Effect          |
| -------------- | -------------------------------------- | --------------- |
| **formality**  | casual, friendly, professional, formal | Tone of voice   |
| **emojiUsage** | none, minimal, moderate, generous      | Emoji frequency |
| **engagement** | gentle, curious, enthusiastic          | Question energy |

---

### Admin Configuration

```typescript
interface AdminConfig {
  displayName: string;

  personality: {
    formality: 'casual' | 'friendly' | 'professional' | 'formal';
    emojiUsage: 'none' | 'minimal' | 'moderate' | 'generous';
    celebration: 'understated' | 'warm' | 'enthusiastic';
  };
}
```

**Example:**

```typescript
// La Directora (warm authority)
{
  displayName: "La Directora",
  personality: {
    formality: 'friendly',
    emojiUsage: 'moderate',
    celebration: 'enthusiastic'
  }
}
```

---

### Scribe Configuration

```typescript
interface ScribeConfig {
  displayName: string;

  personality: {
    thoroughness: 'essential' | 'standard' | 'comprehensive';
  };
}
```

**thoroughness guide:**

- `essential`: Main entities only (people, places, major events)
- `standard`: Entities + relationships + basic context
- `comprehensive`: Above + themes, objects, detailed relationships

**Example:**

```typescript
{
  displayName: "Don Rubén",
  personality: {
    thoroughness: 'comprehensive'
  }
}
```

---

## 4. Cultural Terms

```typescript
{
  culturalTerms: [
    'pulpería', // Nicaraguan corner store
    'gallo pinto', // Traditional rice and beans
    'nacatamal', // Nicaraguan tamale
  ];
}
```

**Purpose:** These words are NEVER translated, just explained in parentheses.

**Example:**

```
Spanish: "Abuela hacía gallo pinto todos los domingos"
English: "Grandma made gallo pinto (rice and beans) every Sunday"
         ↑ NOT translated, just explained
```

---

## Complete Configuration Examples

### Example 1: Nicaraguan Family (Default)

```typescript
const nicaraguanFamilyConfig: SobremesaConfig = {
  familyId: 'family-uuid',
  projectName: 'Sobremesa',

  languages: {
    primary: 'es',
  },

  bots: {
    facilitator: {
      displayName: 'Carmencita',
      personality: {
        formality: 'friendly',
        emojiUsage: 'moderate',
        engagement: 'curious',
      },
    },

    admin: {
      displayName: 'La Directora',
      personality: {
        formality: 'friendly',
        emojiUsage: 'moderate',
        celebration: 'enthusiastic',
      },
    },

    scribe: {
      displayName: 'Don Rubén',
      personality: {
        thoroughness: 'comprehensive',
      },
    },
  },

  culturalTerms: ['pulpería', 'gallo pinto', 'vigorón', 'nacatamal'],
};
```

---

### Example 2: American English Family

```typescript
const americanFamilyConfig: SobremesaConfig = {
  familyId: 'family-uuid',
  projectName: 'Family Stories',

  languages: {
    primary: 'en',
  },

  bots: {
    facilitator: {
      displayName: 'Annie',
      personality: {
        formality: 'friendly',
        emojiUsage: 'minimal',
        engagement: 'curious',
      },
    },

    admin: {
      displayName: 'The Coordinator',
      personality: {
        formality: 'professional',
        emojiUsage: 'minimal',
        celebration: 'warm',
      },
    },

    scribe: {
      displayName: 'The Archivist',
      personality: {
        thoroughness: 'standard',
      },
    },
  },

  culturalTerms: [],
};
```

---

### Example 3: Japanese Family

```typescript
const japaneseFamilyConfig: SobremesaConfig = {
  familyId: 'family-uuid',
  projectName: '家族の記憶',

  languages: {
    primary: 'ja',
  },

  bots: {
    facilitator: {
      displayName: 'ゆい (Yui)',
      personality: {
        formality: 'formal',
        emojiUsage: 'minimal',
        engagement: 'gentle',
      },
    },

    admin: {
      displayName: '管理者',
      personality: {
        formality: 'formal',
        emojiUsage: 'none',
        celebration: 'understated',
      },
    },

    scribe: {
      displayName: '記録者',
      personality: {
        thoroughness: 'comprehensive',
      },
    },
  },

  culturalTerms: ['おばあちゃん', 'おじいちゃん', '家族', '故郷'],
};
```

---

## How to Apply Configuration

### Method 1: Environment Variable

```bash
FAMILY_ID=family-uuid npm start
```

Configuration loaded from database based on `FAMILY_ID`.

### Method 2: Database-stored

```sql
-- Config stored in families table
SELECT config FROM families WHERE id = 'family-uuid';
```

### Method 3: File-based (Development)

```typescript
const config = require('./sobremesa.config.json');
```

---

## Summary

**~10 configuration points:**

- 2 project identity (familyId, projectName)
- 1 language setting
- 6 bot personality traits (2 per bot)
- 1+ cultural terms list

**Key principle:** Internal code is generic, configuration makes it specific to each family.
