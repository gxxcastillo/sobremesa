# Domain Model Specification

**Contract between data extractors (Scribe, Curator) and data writer (Registrar).**

Standardized JSON structure for communication:

```
Scribe/Curator → Domain Model → Registrar → Database
```

---

## Complete Interface

```typescript
interface DomainModel {
  metadata: DomainModelMetadata;
  entities: ExtractedEntities;
  claims: Claim[];
  questions: ProposedQuestion[];
  answers: AnsweredQuestion[];
  conflicts: DetectedConflict[];
  translations: ContentTranslation[];
}
```

---

## Metadata

```typescript
interface DomainModelMetadata {
  sourceMessageId: string;
  familyId: string;
  processorAgent: 'scribe' | 'curator';
  processorVersion: string;
  processedAt: string; // ISO timestamp
  originalLanguage: string; // ISO code
  contentHash?: string;
  confidence: 'high' | 'medium' | 'low';
  uncertaintyFlags?: string[]; // ["fuzzy_date", "ambiguous_person"]
}
```

---

## Extracted Entities

```typescript
interface ExtractedEntities {
  people: Person[];
  places: Place[];
  events: Event[];
  stories: Story[];
  images?: Image[]; // Curator only
}
```

### Person

```typescript
interface Person {
  canonicalName: string;
  aliases: string[];
  relationships?: Relationship[];
  approximateBirthYear?: number;
  approximateDeathYear?: number;
  culturalContext?: string[];
  confidence: 'definite' | 'likely' | 'uncertain';
}

interface Relationship {
  relatedTo: string; // Canonical name
  relationship: string; // "father", "uncle", "wife"
  confidence: 'definite' | 'likely' | 'uncertain';
}
```

### Place

```typescript
interface Place {
  name: string;
  aliases?: string[];
  type: 'city' | 'neighborhood' | 'building' | 'country' | 'region' | 'other';
  parentPlace?: string;
  coordinates?: {
    latitude: number;
    longitude: number;
    confidence: 'exact' | 'approximate' | 'guess';
  };
  culturalSignificance?: string;
  confidence: 'definite' | 'likely' | 'uncertain';
}
```

### Event

```typescript
interface Event {
  title: string;
  description: string;
  date?: EventDate;
  participants?: EventParticipant[];
  locations?: string[];
  culturalContext?: string[];
  confidence: 'definite' | 'likely' | 'uncertain';
}

interface EventDate {
  year?: number;
  month?: number;
  day?: number;
  isApproximate: boolean;
  precision: 'exact' | 'month' | 'year' | 'decade' | 'era';
}

interface EventParticipant {
  name: string;
  role: 'subject' | 'witness' | 'mentioned';
}
```

### Story

```typescript
interface Story {
  title: string;
  contentOriginal: string;
  languageOriginal: string;
  narrator?: string; // Who told this story
  dateNarrated?: string; // When it was told
  peopleInvolved: string[];
  placesInvolved?: string[];
  eventsInvolved?: string[];
  timeframe?: StoryTimeframe;
  themes?: string[];
  culturalElements?: string[];
  confidence: 'verbatim' | 'paraphrased' | 'inferred';
}

interface StoryTimeframe {
  startYear?: number;
  endYear?: number;
  description?: string; // "During the war", "My childhood"
  isApproximate: boolean;
}
```

### Image

```typescript
interface Image {
  sourceUrl?: string;
  caption?: string;
  peopleInImage: PersonInImage[];
  placesInImage?: string[];
  approximateDate?: EventDate;
  culturalContext?: string[];
  confidence: 'definite' | 'likely' | 'uncertain';
}

interface PersonInImage {
  name: string;
  position?: { x: number; y: number; width: number; height: number };
  confidence: 'definite' | 'likely' | 'uncertain';
}
```

---

## Claims

Facts with provenance.

```typescript
interface Claim {
  claimType: ClaimType;
  subject: string; // Who/what the claim is about
  claimValue: ClaimValue;
  claimedBy: string; // Who made this claim (speaker/narrator)
  claimedBySource: 'direct' | 'attributed' | 'hearsay';
  certaintyLanguage?: string; // "definitely", "I think", "maybe"
  sourceContext?: string; // Relevant excerpt from message
  confidence: 'high' | 'medium' | 'low';
}

type ClaimType =
  | 'identity' // "Maria G." is "Maria Garcia"
  | 'date' // Birth/death/event dates
  | 'relationship' // Family connections
  | 'location' // Where someone lived/was born
  | 'detail' // Other biographical facts
  | 'event_detail'; // Details about an event

type ClaimValue =
  | { year: number; month?: number; day?: number } // Date
  | { from: string; to: string } // Relationship
  | { text: string } // Detail
  | { [key: string]: any }; // Flexible
```

**Example:**

```json
{
  "claimType": "date",
  "subject": "Rafael García's birth",
  "claimValue": { "year": 1920, "month": 3 },
  "claimedBy": "María García",
  "claimedBySource": "attributed",
  "certaintyLanguage": "definitely",
  "sourceContext": "My father was born in March 1920",
  "confidence": "high"
}
```

---

## Proposed Questions

Questions to ask the family.

```typescript
interface ProposedQuestion {
  questionText: string;
  aboutEntity?: string; // Person/place/event name
  entityType?: 'person' | 'place' | 'event' | 'story';
  category: QuestionCategory;
  priority: 'high' | 'medium' | 'low';
  reasoning?: string; // Why ask this question
}

type QuestionCategory =
  | 'missing_date'
  | 'missing_place'
  | 'clarify_relationship'
  | 'expand_story'
  | 'resolve_conflict'
  | 'confirm_identity';
```

---

## Answered Questions

Detected answers to pending questions.

```typescript
interface AnsweredQuestion {
  questionId: string; // UUID of original question
  answeredBy: string; // Who answered
  answerText: string; // What they said
  confidence: 'definite_answer' | 'partial_answer' | 'possible_answer';
  extractedInfo?: any; // New claims from answer
}
```

---

## Detected Conflicts

Contradicting information.

```typescript
interface DetectedConflict {
  conflictType: 'contradicts' | 'refines' | 'supports';
  existingClaimId?: string; // UUID if linking to existing claim
  newClaimSubject: string;
  newClaimValue: any;
  conflictDescription: string;
  severity: 'major' | 'minor';
}
```

**Examples:**

- **Contradicts**: Birth year 1920 vs 1922 (major)
- **Refines**: "Nicaragua" vs "Managua, Nicaragua" (minor)
- **Supports**: Two people confirm same fact (minor)

---

## Content Translations

Multi-language support.

```typescript
interface ContentTranslation {
  contentId: string; // Reference to entity/story/claim
  contentType: 'story' | 'claim' | 'question';
  targetLanguage: string; // ISO code
  translatedContent: string;
  translatedBy: 'human' | 'llm';
  confidence: 'high' | 'medium' | 'low';
}
```

---

## Registrar Responsibilities

When Registrar receives a Domain Model:

1. **Entity Deduplication** - Match people/places/events to existing entities
2. **Relationship Normalization** - Store relationships in canonical form
3. **Claim Persistence** - Save claims with full provenance
4. **Conflict Tracking** - Link conflicting claims via `claim_relationships`
5. **Question Management** - Create or update question records
6. **Answer Processing** - Mark questions as answered, extract new claims
7. **Translation Storage** - Store translations with source references
8. **Event Logging** - Record all operations in `event_log`

---

## Validation Rules

**Required fields:**

- `metadata.familyId` - Always required
- `metadata.sourceMessageId` - Always required
- `metadata.processorAgent` - Always required

**Entity validation:**

- Each person must have `canonicalName`
- Each place must have `name`
- Each event must have `title`
- Each story must have `contentOriginal` and `languageOriginal`

**Claim validation:**

- Must have `subject`, `claimValue`, `claimedBy`
- `claimType` must be valid enum value
- `claimedBySource` must be 'direct', 'attributed', or 'hearsay'

**Question validation:**

- Must have `questionText` and `category`
- If `aboutEntity` provided, must reference entity in same model

---

## TypeScript Type Exports

All interfaces exported from: `libs/shared/types/src/lib/domain-model.ts`

```typescript
// Core exports
export type { DomainModel, DomainModelMetadata };
export type { ExtractedEntities, Person, Place, Event, Story, Image };
export type { Claim, ClaimType, ClaimValue };
export type { ProposedQuestion, QuestionCategory };
export type { AnsweredQuestion, DetectedConflict };
export type { ContentTranslation };
```

---

## See Also

- [DATA-MODELS.md](DATA-MODELS.md) - Database persistence layer
- [AGENTS.md](AGENTS.md) - Scribe, Curator, Registrar specifications
- [SERVICES.md](SERVICES.md) - Service layer for entity matching and conflict detection
