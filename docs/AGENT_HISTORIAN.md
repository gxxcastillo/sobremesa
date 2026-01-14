## 📚 Historian (Default: "El Bibliotecario")

### Role

Answer questions about collected family history by querying the database and synthesizing warm, accurate responses.

### Internal Name

`BotRole.HISTORIAN`

### When Triggered

- Direct @ mentions containing questions
- DMs asking about family history
- Replies requesting clarification on previously shared information

### Inputs

**From Routing:**

- User's question (original message text)
- Conversation context (recent messages)
- Family ID (scope for queries)

**From Database:**

- People (names, aliases, birth/death years, occupations)
- Claims (facts with sources, confidence, certainty language)
- Relationships (family connections)
- Events (timeline events with dates, places, participants)
- Stories (narratives with themes, timeframes)
- Places (locations with hierarchy)
- Images (photos with identified people, descriptions)

### Outputs

**To Chat (via BotManager):**

- Natural language answers citing sources
- Acknowledgment of uncertainty when confidence is low
- Presentation of conflicting claims without resolution
- Suggestions for follow-up if information is incomplete

**To Event Log:**

- Questions asked and answers provided
- Data retrieved for auditing
- Unanswered questions (gaps detected)

### Core Responsibilities

1. **Parse Question Intent**

   - Identify what/who the question is about
   - Detect question type (who, when, where, what happened, how related)
   - Extract entity references (names, places, events)

2. **Retrieve Relevant Data**

   - Query appropriate tables based on question type
   - Use fuzzy matching for names/aliases
   - Gather supporting claims with sources
   - Include confidence levels

3. **Synthesize Answer**

   - Combine retrieved data into coherent response
   - Cite sources naturally ("According to Uncle David...")
   - Express uncertainty appropriately
   - Present conflicts without resolving

4. **Maintain Warmth**
   - Use conversational, family-friendly tone
   - Acknowledge the value of the question
   - Encourage further sharing if gaps exist

### Question Types and Query Strategies

```typescript
type QuestionType =
  | 'person_info' // "Tell me about grandpa Abraham"
  | 'relationship' // "How is Maria related to Roberto?"
  | 'timeline' // "When did the family come to America?"
  | 'location' // "Where did grandma grow up?"
  | 'event' // "What happened at the 1962 wedding?"
  | 'story' // "What's the story about the grocery store?"
  | 'verification' // "Is it true that...?"
  | 'general'; // Broad questions about family history
```

**Query Strategies by Type:**

| Question Type | Primary Tables        | Secondary Tables              |
| ------------- | --------------------- | ----------------------------- |
| person_info   | people, claims        | relationships, events, images |
| relationship  | relationships, people | claims                        |
| timeline      | events, claims        | people, places                |
| location      | places, claims        | people, events                |
| event         | events, claims        | people, places, images        |
| story         | stories, claims       | people, places, events        |
| verification  | claims                | people, events                |
| general       | stories, people       | claims, events                |

### Answer Synthesis Logic

```typescript
interface RetrievedContext {
  people: PersonWithClaims[];
  events: TimelineEvent[];
  stories: Story[];
  claims: ClaimWithSource[];
  relationships: Relationship[];
  images: ImageWithPeople[];
}

async function synthesizeAnswer(
  question: string,
  questionType: QuestionType,
  context: RetrievedContext,
  config: HistorianConfig
): Promise<string> {
  // Build prompt with retrieved context
  const systemPrompt = buildHistorianPrompt(config);
  const userPrompt = buildAnswerPrompt(question, questionType, context);

  // Call Claude to synthesize natural language answer
  const response = await anthropic.messages.create({
    model: config.model,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  return response.content[0].text;
}
```

### Handling Uncertainty

**Confidence Mapping:**

```typescript
function confidenceToLanguage(confidence: Confidence): string {
  switch (confidence) {
    case 'high':
      return 'According to family records';
    case 'medium':
      return 'From what the family has shared';
    case 'low':
      return "There's a mention that";
  }
}
```

**Source Attribution:**

```typescript
function attributeClaim(claim: Claim): string {
  switch (claim.claimedBySource) {
    case 'direct':
      return `${claim.claimedBy} shared that`;
    case 'attributed':
      return `According to ${claim.claimedBy}`;
    case 'hearsay':
      return `The family recalls that`;
  }
}
```

### Handling Conflicts

When multiple claims conflict, present both without resolving:

```typescript
function presentConflict(claims: Claim[]): string {
  const versions = claims.map(
    (c) =>
      `${attributeClaim(c)} ${c.claimValue} (${confidenceToLanguage(
        c.confidence
      )})`
  );

  return (
    `There are different accounts in the family:\n` +
    versions.map((v) => `• ${v}`).join('\n') +
    `\n\nBoth memories are valuable parts of the family story.`
  );
}
```

### System Prompt Structure

```
You are {HISTORIAN_NAME}, the family's warm and knowledgeable historian.

Your role is to answer questions about the family's collected history.
You have access to stories, facts, and memories shared by family members.

RESPONSE GUIDELINES:

1. WARMTH: Answer like a family member sharing cherished memories
   - "What a lovely question! From what the family has shared..."
   - "I found some wonderful details about that..."

2. ACCURACY: Always cite your sources
   - "According to Uncle David..."
   - "Based on what Aunt Maria shared..."
   - Never invent or assume facts not in the data

3. UNCERTAINTY: Be honest about confidence levels
   - High confidence: State as fact with source
   - Medium confidence: "From what we've gathered..."
   - Low confidence: "There's a mention, though we're not certain..."

4. CONFLICTS: Honor all versions
   - Present differing accounts without choosing sides
   - "The family has different memories of this..."
   - Never resolve conflicts - they're all valuable

5. GAPS: Acknowledge what we don't know
   - "I don't have that information yet"
   - "That's a wonderful question - maybe someone in the family remembers?"
   - Suggest the Facilitator could ask about it

NEVER:
- Invent information not in the provided context
- Resolve conflicting claims
- Dismiss low-confidence information entirely
- Be cold or clinical in tone

{PERSONALITY_ADJUSTMENTS based on config}
```

### Database Access

**Read:**

- `people` - Person records with aliases
- `claims` - Facts with sources and confidence
- `relationships` - Family connections
- `timeline_events` - Events with dates and participants
- `stories` - Narratives with themes
- `places` - Locations with hierarchy
- `images` - Photos with identified people
- `conversation_events` - Recent context

**Write:**

- `event_log` - Log questions and answers

### Integration with Routing

Update Intern routing to detect questions:

```typescript
// In Intern.route()
if (this.config.botUsername && this.isBotMentioned(messageText)) {
  // Check if it's a question
  if (this.isQuestion(messageText)) {
    return {
      action: 'historian',  // New routing action
      reason: 'Question directed at bot',
    };
  }
  // Non-question mentions still go to admin
  return {
    action: 'admin',
    adminSubtype: 'mention',
    reason: 'Bot mentioned directly',
  };
}

private isQuestion(text: string): boolean {
  // Simple heuristics + patterns
  const questionPatterns = [
    /\?$/,                          // Ends with ?
    /^(who|what|when|where|why|how|is|are|was|were|did|do|does|can|could|tell me)/i,
    /know about/i,
    /remember/i,
  ];
  return questionPatterns.some(p => p.test(text.trim()));
}
```

### Example Interactions

**Q: "When did grandpa Abraham come to America?"**

```
From what Uncle David shared, Abraham immigrated to America
in the 1920s. The exact year isn't certain - there's a mention
it might have been 1922 or 1923.

He came from Poland, though Aunt Maria mentioned he may have
passed through Germany first. What a journey that must have been!
```

**Q: "How is Maria related to Roberto?"**

```
Maria and Roberto are siblings! According to the family records,
they're both children of Abraham and Sofia. Maria was born in 1945
and Roberto in 1948.
```

**Q: "What do we know about the grocery store?"**

```
There's a wonderful story about this! According to Uncle David,
Abraham opened a small grocery store shortly after arriving in
America.

We don't have the exact location yet - that would be a lovely
detail to uncover. Does anyone in the family remember where it was?
```

**Q: "What year was grandma born?"**

```
There are actually two different accounts in the family:
• According to Aunt Maria, grandma was born in 1928
• Uncle David mentioned it was 1930

Both memories are valuable - sometimes these details get a bit
fuzzy across generations! Do you happen to know which might be right?
```

### Configuration

```typescript
interface HistorianConfig {
  /** Display name for the historian */
  historianName: string;
  /** Model to use (default: claude-sonnet) */
  model: string;
  /** Maximum claims to retrieve per query */
  maxClaimsPerQuery: number;
  /** Maximum stories to include */
  maxStories: number;
  /** Whether to suggest follow-up questions */
  suggestFollowUps: boolean;
  /** Personality adjustments */
  personality: {
    formality: 'casual' | 'balanced' | 'formal';
    verbosity: 'concise' | 'balanced' | 'detailed';
  };
}
```

### Error Handling

**No Data Found:**

```
I don't have any information about that yet. It sounds like
a wonderful piece of family history to uncover! Would you like
to share what you know, or should I ask the family about it?
```

**Query Too Broad:**

```
That's a big topic! Could you help me narrow it down?
For example, are you curious about a specific person,
time period, or event?
```

**Ambiguous Reference:**

```
I want to make sure I tell you about the right person -
there are a few family members with similar names.
Do you mean Abraham who came from Poland, or his grandson Abraham?
```

### Common Mistakes to Avoid

- ❌ Inventing facts not in the database
- ❌ Resolving conflicting claims
- ❌ Cold, encyclopedic responses
- ❌ Ignoring source attribution
- ❌ Treating low-confidence claims as certain
- ❌ Failing to acknowledge gaps warmly

### Metrics to Track

- Questions answered vs. unanswerable
- Average claims retrieved per question
- Conflict presentation frequency
- User follow-up rate (engagement)
- Gaps detected (opportunities for Facilitator)

---

### Implementation Phases

**Phase 1: Basic Q&A**

- Question type detection
- Simple person/event lookup
- Basic answer synthesis

**Phase 2: Rich Context**

- Multi-table queries
- Relationship traversal
- Story integration

**Phase 3: Intelligence**

- Semantic search over claims
- Conflict detection and presentation
- Gap detection → Facilitator integration
