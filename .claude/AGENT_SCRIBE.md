
## 📝 Scribe (Default: "Don Rubén")

### Role
Silent data extractor and question generator.

### Internal Name
`BotRole.SCRIBE`

### Inputs

**Live Chat Provider Messages (via ordered queue):**
- All messages sequentially
- One at a time, in order

**Database (for context):**
- Recent messages (5 full + 15 summaries)
- Existing people, places, events, stories
- Pending questions
- Active entities

### Outputs

**Domain Model (to Registrar):**
```typescript
{
  // Entities
  people: [{
    name: "Abraham Goldstein",
    aliases: ["Abe", "Grandpa Abe"],
    relationships: [{type: "spouse", to: "Rose Goldstein"}],
    birth_year: 1865,
    confidence: "high"
  }],
  
  places: [{
    name: "Nalewki Street",
    type: "address",
    city: "Warsaw",
    context: "location of family shop"
  }],
  
  events: [{
    title: "Immigration to America",
    description: "Family left Warsaw for New York",
    date: {approximate: "late 1880s", year: 1889},
    people: ["Abraham Goldstein", "Rose Goldstein"],
    significance: "major family transition"
  }],
  
  // Stories
  stories: [{
    title: "The Shop on Nalewki Street",
    content_original: "...",
    language_original: "es",
    content_es: "...",
    content_en: "...",
    people: ["Abraham Goldstein"],
    timeframe: "1870s-1889",
    themes: ["business", "Warsaw"],
    completeness: "partial",
    confidence: "high"
  }],
  
  // Claims (NEW - preferred over direct facts)
  claims: [{
    claim_type: "event_date",
    subject: "Abraham arrival in America",
    claim_value: {year: 1889, precision: "year"},
    claimed_by: "Uncle David",
    confidence: "high",
    certainty_language: "definitely"
  }],
  
  // Questions
  questions: [{
    question: "What kind of shop did Abraham run?",
    type: "gap_fill",
    priority: 70,
    context: {story_id: "001", topic: "shop details"},
    best_person_to_ask: "Uncle David"
  }],
  
  // Answered questions
  answeredQuestions: [{
    questionId: "q_042",
    answeredBy: "Uncle David",
    completeness: "full",
    messageId: "msg_234"
  }],
  
  // Conflicts
  conflicts: [{
    topic: "arrival_date",
    versions: [
      {source: "Uncle David", value: "1889", confidence: "high"},
      {source: "Aunt Sarah", value: "1891", confidence: "medium"}
    ]
  }]
}
```

### Responsibilities

1. **Entity Extraction** - People, places, dates, events
2. **Story Identification** - Detect coherent narratives
3. **Relationship Mapping** - Parent/child, spouse, etc.
4. **Conflict Detection** - Flag disagreements (never resolve)
5. **Question Generation** - Identify gaps worth asking about
6. **Answer Detection** - Check if messages answer pending questions
7. **Language Detection** - Identify es/en/mixed
8. **Translation** - Generate bilingual versions
9. **Cultural Term Preservation** - Never translate configured terms

### Context Strategy

**Tiered context (cost optimization):**
- Recent 5 messages: Full text
- Messages 6-20: Summaries
- Active entities: Last 20 messages
- Pending questions: All
- Recent claims: Last 10

### Bilingual Processing

```typescript
async processMessage(message: Message): Promise<DomainModel> {
  // 1. Detect language
  const language = detectLanguage(message.content);
  
  // 2. Store original
  const original = message.content;
  
  // 3. Translate (preserve cultural terms)
  const translations = await translateWithCulturalTerms(
    original,
    language,
    config.languages,
    config.culturalTerms
  );
  
  // 4. Extract from original language (better accuracy)
  const extraction = await extractEntities(original, language);
  
  // 5. Attach bilingual content to all extracted items
  return {
    ...extraction,
    // Each entity gets bilingual fields
    stories: extraction.stories.map(story => ({
      ...story,
      content_original: original,
      language_original: language,
      ...translations
    }))
  };
}
```

### Database Access

Context loads must be scoped by family_id 

**Read:**
- `messages` (recent context)
- `people`, `places`, `events`, `stories` (existing entities)
- `questions` (pending, to check for answers)
- `claims` (recent claims for context)

**Write:** None (outputs to Registrar)

### System Prompt Structure

```
You are {SCRIBE_NAME}, the silent scribe.

YOUR ROLE:
- Extract entities, relationships, events, stories
- Generate questions about gaps
- Detect answers to pending questions
- Flag conflicts WITHOUT resolving
- Process {PRIMARY_LANGUAGE} and {SECONDARY_LANGUAGES}

CONFLICT DETECTION:
Never auto-resolve. Preserve BOTH versions.

CONFIDENCE LEVELS:
- high: Explicitly stated, certain language
- medium: Implied or uncertain language
- low: Very speculative

CULTURAL TERMS (never translate):
{LIST_OF_CULTURAL_TERMS}

OUTPUT: Domain model (not database schema)

{PERSONALITY_ADJUSTMENTS based on config}
```

### Common Mistakes
- ❌ Writing directly to database
- ❌ Auto-resolving conflicts
- ❌ Missing answer detection
- ❌ Processing out of order
- ❌ Translating cultural terms
- ❌ Ignoring name variations

---
