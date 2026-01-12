# Domain Model Specification

**Contract between data extractors (Scribe, Curator) and data writer (Registrar).**

This document defines the domain model structure that Scribe and Curator must produce, and that Registrar must consume and persist.

---

## Purpose

**Problem:** Scribe/Curator need to extract data. Registrar needs to save data. How do they communicate?

**Solution:** Domain Model - a standardized JSON structure that represents extracted family history data.

**Flow:**
```
Scribe → Domain Model → Registrar → Database
Curator → Domain Model → Registrar → Database
```

---

## Complete Domain Model Interface

```typescript
interface DomainModel {
  // Metadata
  metadata: DomainModelMetadata;
  
  // Core entities
  entities: ExtractedEntities;
  
  // Claims (facts with provenance)
  claims: Claim[];
  
  // Questions to ask
  questions: ProposedQuestion[];
  
  // Answers detected
  answers: AnsweredQuestion[];
  
  // Detected conflicts
  conflicts: DetectedConflict[];
  
  // Content translations
  translations: ContentTranslation[];
}
```

---

## 1. Metadata

Context about the domain model itself.

```typescript
interface DomainModelMetadata {
  // Source information
  sourceMessageId: string;           // UUID of processed message
  familyId: string;                  // Family scope
  processorAgent: 'scribe' | 'curator';
  processorVersion: string;          // Agent version (for auditing)
  
  // Processing metadata
  processedAt: string;               // ISO timestamp
  originalLanguage: string;          // Detected language (ISO code)
  contentHash?: string;              // Optional content integrity hash
  
  // Quality indicators
  confidence: 'high' | 'medium' | 'low';
  uncertaintyFlags?: string[];       // ["fuzzy_date", "ambiguous_person", ...]
}
```

**Example:**
```json
{
  "sourceMessageId": "msg-uuid-123",
  "familyId": "family-uuid-456",
  "processorAgent": "scribe",
  "processorVersion": "1.0.0",
  "processedAt": "2026-01-10T15:30:00Z",
  "originalLanguage": "es",
  "confidence": "high"
}
```

---

## 2. Extracted Entities

People, places, events, stories, and images identified in the message.

```typescript
interface ExtractedEntities {
  people: Person[];
  places: Place[];
  events: Event[];
  stories: Story[];
  images?: Image[];  // Only from Curator
}
```

### Person

```typescript
interface Person {
  // Identity
  canonicalName: string;            // Best guess at full name
  aliases: string[];                // Other names mentioned
  
  // Relationships (as described)
  relationships?: Relationship[];
  
  // Additional context
  approximateBirthYear?: number;
  approximateDeathYear?: number;
  culturalContext?: string[];       // ["Nicaraguan", "Catholic", ...]
  
  // Confidence
  confidence: 'definite' | 'likely' | 'uncertain';
}

interface Relationship {
  relatedTo: string;                // Canonical name of related person
  relationship: string;             // "father", "uncle", "wife", etc.
  confidence: 'definite' | 'likely' | 'uncertain';
}
```

**Example:**
```json
{
  "canonicalName": "Rafael García",
  "aliases": ["Grandpa Rafael", "Don Rafael", "Papá"],
  "relationships": [
    {
      "relatedTo": "María García",
      "relationship": "father",
      "confidence": "definite"
    }
  ],
  "approximateBirthYear": 1920,
  "culturalContext": ["Nicaraguan", "Managua"],
  "confidence": "definite"
}
```

### Place

```typescript
interface Place {
  // Identity
  name: string;                     // Place name
  aliases?: string[];               // Other names
  
  // Location hierarchy
  type: 'city' | 'neighborhood' | 'building' | 'country' | 'region' | 'other';
  parentPlace?: string;             // "Managua" if this is "Barrio San Judas"
  
  // Coordinates (if mentioned/known)
  coordinates?: {
    latitude: number;
    longitude: number;
    confidence: 'exact' | 'approximate' | 'guess';
  };
  
  // Cultural context
  culturalSignificance?: string;    // "Historical market district"
  
  confidence: 'definite' | 'likely' | 'uncertain';
}
```

**Example:**
```json
{
  "name": "Managua",
  "aliases": ["la capital", "la city"],
  "type": "city",
  "parentPlace": "Nicaragua",
  "culturalSignificance": "Capital city devastated by 1972 earthquake",
  "confidence": "definite"
}
```

### Event

```typescript
interface Event {
  // Identity
  title: string;                    // Short description
  description: string;              // Full description
  
  // Temporal
  date?: EventDate;
  
  // Spatial
  location?: string;                // Place name (links to Place entity)
  
  // Participants
  participants?: string[];          // Person names involved
  
  // Type
  eventType?: 'birth' | 'death' | 'marriage' | 'migration' | 'celebration' | 'trauma' | 'other';
  
  // Cultural context
  culturalContext?: string[];
  
  confidence: 'definite' | 'likely' | 'uncertain';
}

interface EventDate {
  year?: number;
  month?: number;
  day?: number;
  era?: string;                     // "1950s", "post-earthquake", "during the war"
  certainty: 'exact' | 'approximate' | 'era-only' | 'unknown';
}
```

**Example:**
```json
{
  "title": "Rafael's arrival in Managua",
  "description": "Rafael García moved from the countryside to Managua to open a pulpería",
  "date": {
    "year": 1945,
    "certainty": "approximate"
  },
  "location": "Managua",
  "participants": ["Rafael García"],
  "eventType": "migration",
  "confidence": "likely"
}
```

### Story

```typescript
interface Story {
  // Identity
  title: string;                    // Generated title
  summary: string;                  // Brief summary
  
  // Content (original + translations handled separately)
  fragments: StoryFragment[];       // Multiple messages can contribute
  
  // Connections
  relatedPeople: string[];          // Person names
  relatedPlaces: string[];          // Place names
  relatedEvents: string[];          // Event titles
  
  // Temporal context
  timeframe?: EventDate;
  
  // Themes
  themes?: string[];                // ["family business", "resilience", "migration", ...]
  emotions?: string[];              // ["pride", "loss", "joy", ...]
  
  // Status
  completeness: 'fragment' | 'partial' | 'complete';
  
  confidence: 'high' | 'medium' | 'low';
}

interface StoryFragment {
  messageId: string;                // Source message
  sequenceNumber: number;           // Order in story
  contributorName: string;          // Who told this part
  addedAt: string;                  // ISO timestamp
}
```

**Example:**
```json
{
  "title": "Rafael's pulpería in Managua",
  "summary": "Rafael García ran a small corner store (pulpería) in Managua starting around 1945",
  "fragments": [
    {
      "messageId": "msg-uuid-123",
      "sequenceNumber": 1,
      "contributorName": "Uncle David",
      "addedAt": "2026-01-10T15:30:00Z"
    }
  ],
  "relatedPeople": ["Rafael García"],
  "relatedPlaces": ["Managua"],
  "timeframe": {
    "year": 1945,
    "certainty": "approximate"
  },
  "themes": ["family business", "entrepreneurship"],
  "completeness": "partial",
  "confidence": "high"
}
```

### Image (Curator Only)

```typescript
interface Image {
  // Source
  externalImageId: string;          // Chat Provider file_id or URL
  
  // Analysis
  description: string;              // What's visible
  detectedPeople?: ImagePerson[];   // People identified
  detectedText?: string;            // OCR results
  
  // Context
  estimatedEra?: string;            // "1940s", "1960s", etc.
  estimatedLocation?: string;       // Place name if identifiable
  
  // Visual attributes
  photoType?: 'portrait' | 'group' | 'document' | 'landscape' | 'object' | 'other';
  condition?: 'excellent' | 'good' | 'fair' | 'poor' | 'damaged';
  
  // Connections
  relatedStories?: string[];        // Story titles this photo relates to
  
  confidence: 'high' | 'medium' | 'low';
}

interface ImagePerson {
  name?: string;                    // If identified
  position: string;                 // "front row, left", "center", etc.
  estimatedAge?: string;            // "child", "young adult", "elderly"
  confidence: 'definite' | 'likely' | 'guess';
}
```

---

## 3. Claims

Every fact with provenance.

```typescript
interface Claim {
  // Identity
  claimType: ClaimType;
  subject: string;                  // Who/what the claim is about
  
  // The claim itself
  claimValue: ClaimValue;
  
  // Provenance
  sourceMessageId: string;
  claimedBy: string;                // Person who made the claim
  claimedAt: string;                // ISO timestamp
  
  // Confidence
  confidence: 'high' | 'medium' | 'low';
  certaintyLanguage?: string;       // "definitely", "I think", "maybe", etc.
  
  // Conflict detection
  potentialConflicts?: string[];    // Claim IDs that might conflict
}

type ClaimType =
  | 'birth_year'
  | 'death_year'
  | 'location'
  | 'relationship'
  | 'occupation'
  | 'event_date'
  | 'name_spelling'
  | 'attribute'
  | 'other';

type ClaimValue = string | number | { [key: string]: any };
```

**Examples:**
```json
[
  {
    "claimType": "birth_year",
    "subject": "Rafael García",
    "claimValue": 1920,
    "sourceMessageId": "msg-123",
    "claimedBy": "Uncle David",
    "claimedAt": "2026-01-10T15:30:00Z",
    "confidence": "medium",
    "certaintyLanguage": "I think"
  },
  {
    "claimType": "location",
    "subject": "Rafael's pulpería",
    "claimValue": "Barrio San Judas, Managua",
    "sourceMessageId": "msg-124",
    "claimedBy": "Aunt Sarah",
    "claimedAt": "2026-01-10T16:00:00Z",
    "confidence": "high",
    "certaintyLanguage": "definitely",
    "potentialConflicts": ["claim-uuid-456"]
  }
]
```

---

## 4. Proposed Questions

Questions the Scribe/Curator wants to ask.

```typescript
interface ProposedQuestion {
  // Question content
  questionText: string;             // The actual question (Facilitator will add warmth)
  questionType: QuestionType;
  
  // Context
  relatedTo: QuestionContext;
  
  // Priority
  priority: 1 | 2 | 3 | 4 | 5;      // 1 = highest, 5 = lowest
  reasoning?: string;               // Why ask this question
  
  // Metadata
  proposedBy: 'scribe' | 'curator';
  proposedAt: string;               // ISO timestamp
}

type QuestionType =
  | 'missing_detail'    // Gap in story (date, place, name)
  | 'clarification'     // Ambiguous information
  | 'expansion'         // Could tell more
  | 'identification'    // Who is this person (photo)
  | 'verification'      // Confirm conflicting info
  | 'context'           // Background/cultural context
  | 'connection';       // How does this relate to other stories

interface QuestionContext {
  storyTitle?: string;
  personName?: string;
  placeName?: string;
  eventTitle?: string;
  imageId?: string;
  claimId?: string;
}
```

**Examples:**
```json
[
  {
    "questionText": "what street was Rafael's pulpería on?",
    "questionType": "missing_detail",
    "relatedTo": {
      "storyTitle": "Rafael's pulpería in Managua",
      "placeName": "Managua"
    },
    "priority": 2,
    "reasoning": "Story mentions the pulpería but not specific location",
    "proposedBy": "scribe",
    "proposedAt": "2026-01-10T15:30:00Z"
  },
  {
    "questionText": "who are the three people in the doorway?",
    "questionType": "identification",
    "relatedTo": {
      "imageId": "img-uuid-789"
    },
    "priority": 1,
    "reasoning": "Photo shows three unidentified people",
    "proposedBy": "curator",
    "proposedAt": "2026-01-10T16:00:00Z"
  }
]
```

---

## 5. Answered Questions

Questions that were answered in this message.

```typescript
interface AnsweredQuestion {
  // Which question was answered
  questionId: string;               // UUID from questions table
  
  // The answer
  answerText: string;               // What was said
  answerType: 'direct' | 'indirect' | 'partial';
  
  // Source
  answeredBy: string;               // Person name
  answeredAt: string;               // ISO timestamp
  
  // Quality
  completeness: 'full' | 'partial' | 'tangential';
  confidence: 'definite' | 'likely' | 'uncertain';
}
```

**Example:**
```json
{
  "questionId": "question-uuid-123",
  "answerText": "It was on Calle 15 de Septiembre, near the old market",
  "answerType": "direct",
  "answeredBy": "Uncle David",
  "answeredAt": "2026-01-10T17:00:00Z",
  "completeness": "full",
  "confidence": "definite"
}
```

---

## 6. Detected Conflicts

Conflicting information found.

```typescript
interface DetectedConflict {
  // What conflicts
  conflictType: ConflictType;
  subject: string;                  // What the conflict is about
  
  // The conflicting claims
  claim1Id: string;                 // First claim (from this or prior processing)
  claim2Id: string;                 // Conflicting claim (usually from current message)
  
  // Details
  description: string;              // Human-readable description
  
  // Severity
  severity: 'minor' | 'moderate' | 'significant';
  
  // Metadata
  detectedAt: string;               // ISO timestamp
}

type ConflictType =
  | 'date_mismatch'
  | 'location_mismatch'
  | 'name_variation'
  | 'relationship_mismatch'
  | 'factual_contradiction'
  | 'interpretation_difference';
```

**Example:**
```json
{
  "conflictType": "date_mismatch",
  "subject": "Rafael's arrival in Managua",
  "claim1Id": "claim-uuid-111",
  "claim2Id": "claim-uuid-222",
  "description": "Uncle David says 1945, Aunt Sarah says 1947",
  "severity": "minor",
  "detectedAt": "2026-01-10T15:30:00Z"
}
```

---

## 7. Content Translations

Translated versions of content.

```typescript
interface ContentTranslation {
  // Source
  originalContent: string;
  originalLanguage: string;         // ISO code
  
  // Translations
  translations: Translation[];
  
  // Cultural preservation
  culturalTerms?: CulturalTerm[];
}

interface Translation {
  language: string;                 // ISO code
  translatedContent: string;
  translatorAgent: 'claude' | 'deepl';
  translatedAt: string;             // ISO timestamp
}

interface CulturalTerm {
  term: string;                     // The term to preserve
  explanation: string;              // Brief explanation
  language: string;                 // Original language of term
}
```

**Example:**
```json
{
  "originalContent": "Mi abuelo tenía una pulpería en Managua",
  "originalLanguage": "es",
  "translations": [
    {
      "language": "en",
      "translatedContent": "My grandfather had a pulpería in Managua",
      "translatorAgent": "claude",
      "translatedAt": "2026-01-10T15:30:00Z"
    }
  ],
  "culturalTerms": [
    {
      "term": "pulpería",
      "explanation": "Traditional Nicaraguan corner store selling basic goods",
      "language": "es"
    }
  ]
}
```

---

## Complete Example: Domain Model

```json
{
  "metadata": {
    "sourceMessageId": "msg-uuid-123",
    "familyId": "family-uuid-456",
    "processorAgent": "scribe",
    "processorVersion": "1.0.0",
    "processedAt": "2026-01-10T15:30:00Z",
    "originalLanguage": "es",
    "confidence": "high"
  },
  "entities": {
    "people": [
      {
        "canonicalName": "Rafael García",
        "aliases": ["Grandpa Rafael", "Don Rafael"],
        "relationships": [
          {
            "relatedTo": "David García",
            "relationship": "father",
            "confidence": "definite"
          }
        ],
        "approximateBirthYear": 1920,
        "culturalContext": ["Nicaraguan"],
        "confidence": "definite"
      }
    ],
    "places": [
      {
        "name": "Managua",
        "type": "city",
        "parentPlace": "Nicaragua",
        "confidence": "definite"
      }
    ],
    "events": [
      {
        "title": "Rafael opens pulpería",
        "description": "Rafael García opened a pulpería in Managua",
        "date": {
          "year": 1945,
          "certainty": "approximate"
        },
        "location": "Managua",
        "participants": ["Rafael García"],
        "eventType": "other",
        "confidence": "likely"
      }
    ],
    "stories": [
      {
        "title": "Rafael's pulpería in Managua",
        "summary": "Rafael García ran a traditional corner store (pulpería) in Managua",
        "fragments": [
          {
            "messageId": "msg-uuid-123",
            "sequenceNumber": 1,
            "contributorName": "Uncle David",
            "addedAt": "2026-01-10T15:30:00Z"
          }
        ],
        "relatedPeople": ["Rafael García"],
        "relatedPlaces": ["Managua"],
        "themes": ["family business"],
        "completeness": "partial",
        "confidence": "high"
      }
    ]
  },
  "claims": [
    {
      "claimType": "event_date",
      "subject": "Rafael's pulpería opening",
      "claimValue": 1945,
      "sourceMessageId": "msg-uuid-123",
      "claimedBy": "Uncle David",
      "claimedAt": "2026-01-10T15:30:00Z",
      "confidence": "medium",
      "certaintyLanguage": "around"
    }
  ],
  "questions": [
    {
      "questionText": "what street was the pulpería on?",
      "questionType": "missing_detail",
      "relatedTo": {
        "storyTitle": "Rafael's pulpería in Managua"
      },
      "priority": 2,
      "reasoning": "Location mentioned but not specific street",
      "proposedBy": "scribe",
      "proposedAt": "2026-01-10T15:30:00Z"
    }
  ],
  "answers": [],
  "conflicts": [],
  "translations": [
    {
      "originalContent": "Mi abuelo tenía una pulpería en Managua",
      "originalLanguage": "es",
      "translations": [
        {
          "language": "en",
          "translatedContent": "My grandfather had a pulpería in Managua",
          "translatorAgent": "claude",
          "translatedAt": "2026-01-10T15:30:00Z"
        }
      ],
      "culturalTerms": [
        {
          "term": "pulpería",
          "explanation": "Traditional Nicaraguan corner store",
          "language": "es"
        }
      ]
    }
  ]
}
```

---

## Registrar Responsibilities

When Registrar receives a DomainModel, it must:

1. **Validate** - Ensure all required fields present
2. **Deduplicate** - Match entities to existing (fuzzy matching)
3. **Map** - Convert domain model → database schema
4. **Persist** - Insert/update in correct tables
5. **Link** - Create foreign key relationships
6. **Log** - Write to event_log
7. **Hash** (optional) - Generate content hashes for blockchain

---

## Validation Rules

```typescript
// Registrar MUST validate:
function validateDomainModel(model: DomainModel): ValidationResult {
  const errors: string[] = [];
  
  // Required fields
  if (!model.metadata.sourceMessageId) errors.push('Missing sourceMessageId');
  if (!model.metadata.familyId) errors.push('Missing familyId');
  
  // Family ID consistency
  const allFamilyIds = [
    model.metadata.familyId,
    ...model.claims.map(c => extractFamilyId(c))
  ];
  if (new Set(allFamilyIds).size > 1) {
    errors.push('Inconsistent family_id across domain model');
  }
  
  // Claim validation
  model.claims.forEach(claim => {
    if (!claim.subject) errors.push('Claim missing subject');
    if (!claim.sourceMessageId) errors.push('Claim missing sourceMessageId');
  });
  
  // Question validation
  model.questions.forEach(q => {
    if (!q.questionText) errors.push('Question missing text');
    if (q.priority < 1 || q.priority > 5) errors.push('Invalid priority');
  });
  
  return {
    valid: errors.length === 0,
    errors
  };
}
```

---

## TypeScript Type Exports

All types defined in this document should be exported from:

```
libs/domain/src/lib/domain-model.ts
```

Usage:
```typescript
import { DomainModel, Claim, Person, ProposedQuestion } from '@sobremesa/domain';
```

---

## Next Steps

1. ✅ Read this domain model spec
2. → Implement types in `libs/domain`
3. → Update Scribe to output DomainModel
4. → Update Registrar to consume DomainModel
5. → Write validation tests
