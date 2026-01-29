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
DomainModel {
  metadata      - Source info, confidence, language
  entities      - People, places, events, stories, images
  claims        - Facts with provenance
  questions     - Questions to ask
  answers       - Detected answers to pending questions
  conflicts     - Contradicting information
  translations  - Multi-language content
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

## Questions

Proposed questions with:

- Question text
- About which entity (person/place/event)
- Category (missing date, clarify relationship, resolve conflict)
- Priority (high/medium/low)

---

## Answers

Detected answers with:

- Original question ID
- Who answered
- Answer text
- Confidence (definite/partial/possible)
- Extracted information

---

## Conflicts

Contradicting information:

- **Contradicts**: Mutually exclusive (birth year 1920 vs 1922)
- **Refines**: More specific (Nicaragua → Managua, Nicaragua)
- **Supports**: Confirms existing claim

---

## Registrar Responsibilities

When receiving a Domain Model:

1. **Deduplicate** - Match entities to existing records
2. **Normalize** - Store relationships in canonical form
3. **Track conflicts** - Link contradicting claims
4. **Manage questions** - Create or update question records
5. **Process answers** - Mark questions answered, extract new claims
6. **Log everything** - Complete audit trail

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
