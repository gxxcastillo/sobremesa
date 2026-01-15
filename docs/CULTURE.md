# Cultural Adaptation Guide

How to adapt Sobremesa for different families, cultures, and languages.

**Note:** This is a living document. Add cultural insights as you work with different families.

---

## Core Principle

Warmth is universal. How it's expressed varies by culture.

The four-part formula ([Warmth] + [Question] + [Permission] + [Gratitude]) works everywhere, but:

- Word choice changes
- Formality levels differ
- Emoji usage varies
- Directness expectations differ

---

## Language-Specific Considerations

### Spanish / Latino Cultures

**Characteristics:**

- More effusive expressions natural
- Diminutives show affection ("abuelita", "Tía")
- Higher emoji usage expected
- Longer emotional expressions welcome
- Code-switching common (Spanish + English mix)

**Example question:**

```
"¡Tía Martha, qué historia tan linda! Si te acuerdas, ¿en qué año fue
eso? No te preocupes si no recuerdas el detalle exacto. ¡Gracias por
compartir! ❤️"
```

**Formality:** Generally `friendly` or `casual`  
**Verbosity:** `moderate` or `detailed`  
**Emoji:** `moderate` or `generous`

---

### English / American Cultures

**Characteristics:**

- Moderate warmth (not too effusive)
- Direct but friendly
- Casual tone acceptable
- Minimal to moderate emoji
- Efficiency valued

**Example question:**

```
"Uncle David, what a great story! Do you happen to remember what year
that was? No worries if not. Thanks for sharing!"
```

**Formality:** `friendly`  
**Verbosity:** `concise` or `moderate`  
**Emoji:** `minimal` or `moderate`

---

### Japanese / East Asian Cultures

**Characteristics:**

- More reserved expression
- Respect and formality important
- Less direct (indirect permission-giving)
- Minimal emoji usage
- Hierarchy respected (honorifics)

**Example question:**

```
"Thank you for sharing this meaningful story about your grandfather.
If I may respectfully ask, do you recall approximately when this
occurred? Please feel free to share only what you remember comfortably."
```

**Formality:** `formal` or `professional`  
**Verbosity:** `moderate`  
**Emoji:** `none` or `minimal`

---

## Cultural Term Preservation

### What Are Cultural Terms?

Words/phrases that carry cultural meaning beyond translation:

- Food names (gallo pinto, sushi, pasta)
- Cultural roles (pulpería, izakaya, bodega)
- Traditions (quinceañera, Bar Mitzvah, Diwali)
- Place names unique to culture

### Why Preserve Them?

**Bad translation example:**

```
Spanish: "Mi abuela hacía gallo pinto todos los domingos"
English: "My grandmother made rice and beans every Sunday"
```

❌ Loses cultural specificity. "Gallo pinto" is not just "rice and beans."

**Good preservation:**

```
Spanish: "Mi abuela hacía gallo pinto todos los domingos"
English: "My grandmother made gallo pinto (traditional rice and beans) every Sunday"
```

✅ Preserves term, provides explanation.

### How to Configure

Add to `culturalTerms` array in configuration:

```typescript
culturalTerms: [
  'pulpería', // Nicaraguan corner store
  'gallo pinto', // Traditional rice and beans
  'vigorón', // Traditional dish
  'nacatamal', // Nicaraguan tamale
];
```

Scribe will:

- Never translate these words
- Add brief explanation in parentheses when needed
- Preserve in both language versions

---

## Formality Levels by Culture

### When to Use Each Level

**Casual:**

- Close-knit families
- Younger generations
- Very informal cultures (some Latino, American)

**Friendly (Default):**

- Most families
- Balances warmth and respect
- Works across most cultures

**Professional:**

- More formal families
- Business-like preference
- Some American, European contexts

**Formal:**

- Highly respectful cultures (Japanese, some Asian)
- Older generations
- Cultures with strong hierarchy

---

## Emoji Usage Guidelines

### None

- Very formal cultures
- Professional contexts
- Older generations who find them confusing

### Minimal

- Occasional use (❤️ for major milestones)
- Conservative families
- Professional but warm

### Moderate (Default)

- Regular but not excessive (😊 ❤️ 🎉)
- Most families comfortable
- Balanced approach

### Generous

- Frequent use
- Very warm, expressive cultures
- Younger family groups
- Latino, some Asian cultures

---

## Example Configurations by Culture

### Nicaraguan Family (Default)

```typescript
{
  languages: { primary: "es", secondary: ["en"] },
  bots: {
    facilitator: {
      displayName: "Carmencita",
      personality: {
        formality: 'friendly',
        verbosity: 'moderate',
        emojiUsage: 'moderate',
        engagement: 'curious',
        patience: 'patient'
      }
    }
  },
  culturalTerms: ["pulpería", "gallo pinto", "vigorón", "nacatamal"]
}
```

---

### Japanese Family

```typescript
{
  languages: { primary: "ja", secondary: ["en"] },
  bots: {
    facilitator: {
      displayName: "ゆい (Yui)",
      personality: {
        formality: 'formal',
        verbosity: 'moderate',
        emojiUsage: 'minimal',
        engagement: 'gentle',
        patience: 'very-patient'
      }
    }
  },
  culturalTerms: ["おばあちゃん", "おじいちゃん", "家族", "故郷"]
}
```

---

### American Family (English-only)

```typescript
{
  languages: { primary: "en", secondary: [] },
  bots: {
    facilitator: {
      displayName: "Annie",
      personality: {
        formality: 'friendly',
        verbosity: 'concise',
        emojiUsage: 'minimal',
        engagement: 'curious',
        patience: 'patient'
      }
    }
  },
  culturalTerms: []
}
```

---

### Italian Family

```typescript
{
  languages: { primary: "it", secondary: ["en"] },
  bots: {
    facilitator: {
      displayName: "Nonna Sofia",  // "Grandma Sofia"
      personality: {
        formality: 'friendly',
        verbosity: 'detailed',  // Italians tell full stories!
        emojiUsage: 'generous',
        engagement: 'enthusiastic',
        patience: 'patient'
      }
    }
  },
  culturalTerms: ["nonna", "nonno", "famiglia", "la cucina", "pranzo"]
}
```

---

## Questions to Ask When Adapting

1. **How direct is this culture?**
   - Very direct → Lower formality
   - Indirect → Higher formality

2. **How is emotion expressed?**
   - Openly → More emoji, effusive language
   - Reserved → Less emoji, measured language

3. **What's the age range?**
   - Younger → More casual, more emoji
   - Older → More formal, less emoji
   - Mixed → Moderate approach

4. **Urban or traditional?**
   - Urban/modern → Can be more casual
   - Traditional → Respect formality

5. **What are key cultural foods/places/traditions?**
   - Add to `culturalTerms`

6. **How is family hierarchy?**
   - Strong → Use titles, honorifics
   - Relaxed → Can be more casual

---

## Common Cultural Mistakes to Avoid

### Mistake 1: Over-Translation

**Bad:** Translate everything, lose cultural meaning  
**Good:** Preserve cultural terms with explanations

### Mistake 2: Wrong Formality

**Bad:** Too casual with formal culture (or vice versa)  
**Good:** Match cultural expectations

### Mistake 3: Emoji Overload

**Bad:** 🎉🎉🎉 in formal Japanese context  
**Good:** Minimal or no emoji for reserved cultures

### Mistake 4: Ignoring Code-Switching

**Bad:** Force pure Spanish or pure English  
**Good:** Support natural mixing ("Fuimos al market")

### Mistake 5: Generic Approach

**Bad:** Same config for everyone  
**Good:** Customize for each family's culture

---

## Growing This Document

As you work with different families, add:

**New cultural sections:**

- Chinese families
- Indian families
- Middle Eastern families
- African families
- etc.

**Lessons learned:**

- What worked
- What didn't
- Surprising insights

**Cultural term lists:**

- Expand lists for each culture
- Note regional variations

**Example configurations:**

- Real families (anonymized)
- What settings worked best

---

## Resources for Cultural Research

When configuring for unfamiliar cultures:

1. **Ask family members** - Best source
2. **Cultural communication guides** - Business etiquette guides helpful
3. **Language learning resources** - Often cover cultural norms
4. **Community feedback** - Test and iterate

---

This is a starting point. Cultural adaptation is ongoing learning.

**Remember:** The goal is authentic, respectful engagement that makes families want to share.
