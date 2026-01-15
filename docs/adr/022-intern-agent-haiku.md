# ADR-022: Intern Agent for Lightweight Preprocessing (Haiku)

## Status

Accepted

## Date

2026-01-12

## Context

The Scribe agent uses Claude Sonnet for high-quality entity extraction, but:

- Many messages don't contain relevant family history content
- Running Sonnet on every message is expensive
- Some tasks (filtering, image linking) don't require Sonnet's full capabilities
- Need to reduce API costs while maintaining quality

## Decision

Create an "Intern" agent that uses Claude Haiku (`claude-3-5-haiku-20241022`) for lightweight preprocessing tasks:

### Tasks

1. **Message Filtering** - Determines if a message is relevant for Scribe extraction
2. **Image Linking** - Detects when text messages reference recently shared images

### Pipeline Position

```
Message → Intern (filter) → Scribe → Intern (image link) → Registrar
```

### Image Reference Types

- `describes` - Text describes image content
- `identifies_people` - Text identifies people in image
- `provides_context` - Text provides date, location, or event context
- `asks_about` - Text asks a question about the image

## Consequences

### Positive

- Significant cost savings (Haiku is ~10x cheaper than Sonnet)
- Faster preprocessing (Haiku has lower latency)
- Catches image references Scribe might miss (specialized task)
- Domain model augmentation pattern is extensible

### Negative

- Additional agent to maintain
- Two-step image detection (Scribe + Intern fallback)

### Trade-off

Cost efficiency worth the added complexity
