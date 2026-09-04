# ADR-022: Intern Agent for Lightweight Preprocessing (Haiku)

## Status

Accepted

**2026-09-04:** Implementation-status note. This decision was not actually in effect until now:
`loadAIConfig`'s Anthropic provider config set a hardcoded `defaultModel`, which short-circuited
`getModelForTier`'s tier switch for every agent, so Intern (and Facilitator) ran on the same Sonnet
model as Scribe/Historian from this ADR's acceptance date until the fix (`agent-hygiene-plan.md`
item #1). Intern's Haiku pin is now `claude-haiku-4-5` (`DEFAULT_MODELS.anthropic.fast`), not the
`claude-3-5-haiku-20241022` named below, which was retired.

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
