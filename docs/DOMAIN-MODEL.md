# Domain Model

**Contract between data extractors (Scribe, Curator) and data writer (Registrar).**

```
Scribe/Curator → Domain Model (JSON) → Registrar → Database
```

---

## Purpose

Standardized structure for agents to communicate extracted family history data.

---

## Structure

```
ScribeDomainModel {
  metadata        - Source event, family, processing info
  entities        - People, places, events, relationships
  claims          - Facts with provenance
  story           - Story fragment if detected
  imageReferences - References to recently shared images
  interpretation  - Pronoun resolution and ambiguity tracking
}

CuratorDomainModel {
  metadata        - Source event, family, processing info
  imageAnalysis   - Description, people count, era estimate, OCR
  connections     - Possible matches to existing people/stories
  questions       - Proposed identification questions
}
```

---

## Metadata

Context about the extraction:

- **Source**: Which message, which family, which agent
- **Language**: Original language detected
- **Confidence**: High/medium/low quality indicator
- **Flags**: Uncertainties detected (fuzzy dates, ambiguous people)

---

## Entities

### People

- Name and aliases
- Relationships (father, uncle, wife)
- Birth/death year approximations
- Cultural context

### Places

- Name and type (city, neighborhood, country)
- Hierarchy (Managua → Nicaragua)
- Cultural significance

### Events

- Title and description
- Date (with precision: exact, month, year, decade)
- Participants and locations
- Cultural context

### Stories

- Original text and language
- Narrator and timeframe
- People, places, events involved
- Themes and cultural elements
- Confidence (verbatim, paraphrased, inferred)

### Images

- People in image (with positions)
- Places and dates
- Cultural context

---

## Claims

Facts with full provenance:

**Core attributes:**

- **Type**: identity, date, relationship, location, detail
- **Subject**: Who/what the claim is about
- **Value**: The actual claim (date, relationship, detail)
- **Source**: Who made the claim, how (direct/attributed/hearsay)
- **Certainty**: Language used ("definitely", "I think", "maybe")
- **Confidence**: Overall confidence level

**Example:**

- Type: date
- Subject: "Rafael García's birth"
- Value: March 1920
- Source: María García (attributed)
- Certainty: "definitely"

---

## Questions (Curator Only)

The Curator generates identification questions from image analysis:

- Question text
- About which entity (person/place/event)
- Story context
- Priority (numeric)

The Scribe does not generate questions or detect answers.

---

## Conflicts

Contradicting information:

- **Contradicts**: Mutually exclusive (birth year 1920 vs 1922)
- **Refines**: More specific (Nicaragua → Managua, Nicaragua)
- **Supports**: Confirms existing claim

---

## Registrar Responsibilities

When receiving a Domain Model:

1. **Deduplicate** - Match entities to existing records using entity-specific strategies:
   - People: 4-pass fuzzy matching (name, alias, biographical)
   - Places: case-insensitive exact name match
   - Events: word-overlap scoring on title + person/date boosts (threshold 0.6)
   - Stories: composite scoring on title + content + themes (threshold 0.55)
   - Claims: duplicate + conflict detection by subject + type
2. **Merge context** - When events/stories match existing records, link new people/places and append content
3. **Normalize** - Store relationships in canonical form
4. **Track conflicts** - Link contradicting claims (never auto-resolve)
5. **Log everything** - Complete audit trail

The Scribe extracts freely without suppressing duplicates — deduplication is deterministic code in the Registrar, not LLM reasoning in the Scribe.

---

## Validation

**Required:**

- familyId, sourceMessageId, processorAgent

**Entity rules:**

- People need names, places need names, events need titles

**Claim rules:**

- Must have subject, value, source
- Source must be: direct, attributed, or hearsay

---

## Type Definitions

TypeScript interfaces exported from:
`libs/shared/types/src/lib/domain-model.ts`

See codebase for current type definitions.

---

## See Also

- [AGENTS.md](AGENTS.md) - Scribe, Curator, Registrar specs
- [DATA-MODELS.md](DATA-MODELS.md) - Database persistence
- [SERVICES.md](SERVICES.md) - Entity matching and conflict detection
