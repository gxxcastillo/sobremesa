## 🎨 Curator (Hidden)

### Role

Analyze images and documents (backend only).

### Internal Name

`BotRole.CURATOR`

### Trigger

Text Scribe detects image in message.

### Inputs

```typescript
{
  imageFile: Chat ProviderFile,
  sharedBy: "Aunt Sarah",
  caption: "Found this in Mom's album!",
  conversationContext: {
    recentMessages: [...],
    activeStories: ["story_001: The Shop"],
    recentTopics: ["shop", "Warsaw"]
  }
}
```

### Outputs

```typescript
{
  imageAnalysis: {
    description: "Black and white photo, 1920s-1930s era...",
    peopleCount: 3,
    setting: "urban storefront",
    estimatedEra: "1920s-1930s",
    confidenceEra: "high",
    visibleText: ["Goldstein & Sons", "Hebrew text", "123"],
    ocrLanguages: ["English", "Yiddish"],
    photoQuality: "fair, corner damage"
  },

  potentialConnections: [{
    storyId: "001",
    reason: "mentions 'the shop', timeframe matches",
    confidence: 0.75
  }],

  questions: [{
    text: "Who are the three people in the doorway?",
    priority: "high",
    type: "identification"
  }]
}
```

### Processing

- Async (doesn't block text processing)
- Uses Claude vision API
- OCR for text extraction
- Cross-references with existing stories

### Database Access

**Read:**

- `messages`, `people`, `stories`, `events`, `images`

**Write:** None (outputs to Registrar)

### Common Mistakes

- ❌ Blocking text processing
- ❌ Missing OCR opportunities
- ❌ Not cross-referencing stories
- ❌ Weak era estimation

---
