# ADR-021: One Bot Instance Per Family

## Status

Superseded

**2026-07-02:** Superseded by [ADR-029](029-multi-tenant-single-bot-process.md). The running
system deploys one multi-tenant bot process (single `TELEGRAM_BOT_TOKEN`, single `BotManager`,
many rows in `families`), not one process per family. Evidence:
`libs/telegram/src/lib/bot-manager.ts`, `apps/chatbots/src/main.ts`, `families` table schema.

## Date

2026-01-10

## Context

Need to decide deployment model for multi-family support:

- Option A: Single bot instance handles multiple families (shared infrastructure)
- Option B: Separate bot instance per family (complete isolation)

## Decision

Deploy one bot instance per family:

- Each family gets its own running process
- Family ID configured via environment variable
- Complete process isolation between families
- Can scale families independently

### Deployment

```bash
# Family A
FAMILY_ID=family-a-uuid bun nx serve chatbots

# Family B (separate process)
FAMILY_ID=family-b-uuid bun nx serve chatbots
```

## Consequences

### Positive

- Complete isolation (bugs can't affect other families)
- Easy to scale per family
- Simpler code (no multi-tenant routing)
- Family-specific config in env vars

### Negative

- More infrastructure (one instance per family)

### Trade-off

Isolation and simplicity outweigh infrastructure overhead
