# Single Bot + Queue-Only Architecture Refactor

**Status:** Completed
**Date:** 2026-01-14

## Overview

Refactored from 3 Telegram bots to a single bot with a unified queue. The Intern agent will route messages, and Facilitator is triggered fire-and-forget after Registrar persists.

## Current State

### Completed

- [x] Single bot architecture (ChatbotHandler)
- [x] BotManager simplified to single-bot mode
- [x] main.ts updated to use single token
- [x] Facilitator triggered fire-and-forget after Registrar
- [x] Old bot handlers deleted
- [x] Environment variables updated

### Remaining

- [x] Extend Intern to route messages (commands → Admin, content → Scribe)
- [x] Create AdminAgent for command handling
- [x] Update MessageProcessor to include Admin routing

## Architecture

```
Telegram
    ↓
ChatbotHandler (deterministic - just enqueues)
    ↓
Message Queue (existing processing_queue)
    ↓
Intern (AI router) ← TODO: Add routing logic
    ↓
    ├── ignore (spam, noise)
    ├── admin (commands, member events, DMs) → AdminAgent ← TODO
    └── scribe → Scribe → Registrar
                              ↓
                    Facilitator (fire-and-forget)
                              ↓
                    Send question if appropriate
```

## Key Files Changed

| File                                   | Change                                            |
| -------------------------------------- | ------------------------------------------------- |
| `libs/telegram/src/lib/chatbot.ts`     | NEW - Unified bot handler                         |
| `libs/telegram/src/lib/bot-manager.ts` | Simplified to single bot                          |
| `libs/telegram/src/lib/types.ts`       | Updated BotManagerConfig                          |
| `libs/telegram/src/index.ts`           | Updated exports                                   |
| `libs/agents/admin/`                   | NEW - AdminAgent for commands, DMs, member events |
| `libs/agents/intern/src/lib/intern.ts` | Added route() method and routing types            |
| `libs/queue/src/lib/processor.ts`      | Added router and admin processor support          |
| `apps/chatbots/src/main.ts`            | Single token, AdminAgent, router wiring           |
| `.env.example`                         | Single TELEGRAM_BOT_TOKEN                         |

## Files Deleted

- `libs/telegram/src/lib/scribe-bot.ts`
- `libs/telegram/src/lib/admin-bot.ts`
- `libs/telegram/src/lib/facilitator-bot.ts`
- `apps/db/supabase/migrations/20260114000000_add_command_and_facilitator_queues.sql`
- `libs/database/src/lib/repositories/command-queue-repository.ts`
- `libs/database/src/lib/repositories/facilitator-queue-repository.ts`

## Environment Variables

```bash
# Before
TELEGRAM_BOT_TOKEN_SCRIBE=xxx
TELEGRAM_BOT_TOKEN_ADMIN=yyy
TELEGRAM_BOT_TOKEN_FACILITATOR=zzz

# After
TELEGRAM_BOT_TOKEN=xxx
```

Note: `TELEGRAM_BOT_TOKEN_SCRIBE` is still supported as fallback for migration.

## ChatbotHandler Design

The ChatbotHandler is a thin, deterministic ingestion layer:

1. **Registration bootstrap**: Handles `/sobremesa` directly (can't queue without familyId)
2. **Everything else**: Looks up family, enqueues to processing_queue
3. **No AI**: Pure transformation and routing

### Flow for /sobremesa

```
/sobremesa in unregistered chat:
  → Check whitelist
  → Create family
  → Reply with welcome message

/sobremesa in registered chat:
  → Enqueue as text message
  → Intern routes to Admin (shows status)
```

## Next Steps

1. **Extend Intern**: Add routing classification

   ```typescript
   type InternRouting =
     | { action: 'ignore'; reason: string }
     | { action: 'admin'; subtype: 'command' | 'status' | 'dm' }
     | { action: 'scribe' };
   ```

2. **Create AdminAgent**: Handle routed admin actions

   - Show status for registered chats
   - Handle member events
   - Handle DMs

3. **Update MessageProcessor**: Add admin routing path

## Verification

```bash
# Typecheck
npx tsc --noEmit -p libs/telegram/tsconfig.lib.json
npx tsc --noEmit -p apps/chatbots/tsconfig.app.json

# Run chatbots app (requires TELEGRAM_BOT_TOKEN)
npx nx serve chatbots
```
