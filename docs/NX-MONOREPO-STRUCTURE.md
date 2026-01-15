# Nx Monorepo Structure for Sobremesa

Complete directory structure for Sobremesa in an Nx workspace.

## Recommended Nx Monorepo Structure

```
sobremesa-workspace/
├── .claudeproject                    ← Root level (Claude Code reads this)
│
├── .claude/                          ← AI assistant context
│   ├── NX.md                         ← Nx MCP instructions
│   ├── CONFIGURATION.md              ← Config notes
│   └── settings.local.json
│
├── docs/                             ← Human documentation
│   ├── ARCHITECTURE.md
│   ├── AGENTS.md
│   ├── WARMTH.md
│   ├── CULTURE.md
│   ├── IMPLEMENTATION.md
│   └── adr/                          ← Architecture Decision Records
│
├── prompts/                          ← System prompts for agents
│   ├── facilitator.md
│   ├── admin.md
│   ├── scribe.md
│   └── curator.md
│
├── apps/                             ← Nx applications
│   ├── chatbots/         ← Telegram ingestion/orchestration app
│   │   ├── src/
│   │   │   ├── main.ts              ← Entry point
│   │   │   ├── app/
│   │   │   │   ├── bot.ts           ← Chat provider setup
│   │   │   │   ├── handlers/        ← Message handlers
│   │   │   │   └── workflows/       ← Orchestration
│   │   │   └── config/
│   │   │       └── default-config.json
│   │   ├── project.json
│   │   └── tsconfig.json
│   │
│   ├── api/                          ← Optional REST API (future)
│   │   └── ...
│   │
│   └── dashboard/                    ← Optional web dashboard (future)
│       └── ...
│
├── libs/                             ← Nx libraries (reusable)
│   │
│   ├── agents/                       ← All AI agents
│   │   ├── facilitator/
│   │   │   ├── src/
│   │   │   │   ├── index.ts
│   │   │   │   ├── facilitator.ts   ← Main logic
│   │   │   │   ├── decision-engine.ts
│   │   │   │   └── warmth-validator.ts
│   │   │   ├── project.json
│   │   │   └── README.md
│   │   │
│   │   ├── admin/
│   │   │   ├── src/
│   │   │   │   ├── index.ts
│   │   │   │   ├── admin.ts
│   │   │   │   ├── celebration.ts
│   │   │   │   ├── mediation.ts
│   │   │   │   └── coaching/
│   │   │   │       ├── coaching-module.ts
│   │   │   │       └── performance-tracker.ts
│   │   │   └── project.json
│   │   │
│   │   ├── scribe/
│   │   │   ├── src/
│   │   │   │   ├── index.ts
│   │   │   │   ├── scribe.ts
│   │   │   │   ├── extractors/
│   │   │   │   │   ├── entity-extractor.ts
│   │   │   │   │   ├── claim-creator.ts
│   │   │   │   │   └── conflict-detector.ts
│   │   │   │   └── translation/
│   │   │   │       └── translator.ts
│   │   │   └── project.json
│   │   │
│   │   ├── curator/
│   │   │   ├── src/
│   │   │   │   ├── index.ts
│   │   │   │   ├── curator.ts
│   │   │   │   ├── image-analyzer.ts
│   │   │   │   └── ocr-extractor.ts
│   │   │   └── project.json
│   │   │
│   │   ├── intern/                   ← Lightweight Haiku-based preprocessing
│   │   │   ├── src/
│   │   │   │   ├── index.ts
│   │   │   │   └── intern.ts        ← Filter + image linking
│   │   │   └── project.json
│   │   │
│   │   └── registrar/               ← Single writer (pure TypeScript)
│   │       ├── src/
│   │       │   ├── index.ts
│   │       │   └── registrar.ts
│   │       └── project.json
│   │
│   ├── database/                     ← Database layer
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── client.ts            ← Supabase client
│   │   │   ├── repositories/        ← Data access
│   │   │   │   ├── message-repository.ts
│   │   │   │   ├── people-repository.ts
│   │   │   │   ├── claim-repository.ts
│   │   │   │   ├── question-repository.ts
│   │   │   │   └── event-log-repository.ts
│   │   │   ├── models/              ← TypeScript types
│   │   │   │   ├── message.ts
│   │   │   │   ├── person.ts
│   │   │   │   ├── claim.ts
│   │   │   │   └── domain-model.ts
│   │   │   └── migrations/
│   │   │       └── schema.sql       ← Copy from .claude/
│   │   └── project.json
│   │
│   ├── data-writer/                  ← Single writer component
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── data-writer.ts
│   │   │   ├── schema-mapper.ts     ← Domain model → DB
│   │   │   ├── deduplicator.ts      ← Fuzzy matching
│   │   │   └── web3/
│   │   │       └── solana-writer.ts ← Optional
│   │   └── project.json
│   │
│   ├── queue/                        ← Message queue
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── queue.ts             ← Ordered queue
│   │   │   ├── processor.ts         ← Sequential processing
│   │   │   └── retry-handler.ts
│   │   └── project.json
│   │
│   ├── config/                       ← Configuration management
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── config-loader.ts
│   │   │   ├── config-validator.ts
│   │   │   ├── types/
│   │   │   │   └── sobremesa-config.ts
│   │   │   └── defaults/
│   │   │       ├── nicaraguan-family.json
│   │   │       ├── american-family.json
│   │   │       └── japanese-family.json
│   │   └── project.json
│   │
│   ├── prompts/                      ← Prompt management
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── prompt-loader.ts     ← Load from /prompts
│   │   │   └── template-engine.ts   ← Replace placeholders
│   │   └── project.json
│   │
│   ├── claude-api/                   ← Claude API wrapper
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── client.ts
│   │   │   └── types.ts
│   │   └── project.json
│   │
│   ├── chat provider/                     ← Chat Provider utilities
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── client.ts
│   │   │   ├── message-formatter.ts
│   │   │   └── file-handler.ts
│   │   └── project.json
│   │
│   └── shared/                       ← Shared utilities
│       ├── types/                    ← Shared TypeScript types
│       │   ├── src/
│       │   │   ├── index.ts
│       │   │   ├── bot-role.ts
│       │   │   ├── confidence.ts
│       │   │   └── languages.ts
│       │   └── project.json
│       │
│       └── utils/                    ← Shared utilities
│           ├── src/
│           │   ├── index.ts
│           │   ├── logger.ts
│           │   ├── date-utils.ts
│           │   └── text-utils.ts
│           └── project.json
│
├── tools/                            ← Development tools
│   ├── scripts/
│   │   ├── setup-database.ts        ← Run schema.sql
│   │   ├── seed-data.ts             ← Test data
│   │   └── migrate.ts
│   └── generators/                   ← Nx generators (optional)
│
├── docs/                             ← Additional documentation
│   └── api/                          ← API docs (if needed)
│
├── package.json                      ← Root package.json
├── nx.json                           ← Nx configuration
├── tsconfig.base.json                ← Base TypeScript config
├── .env.example                      ← Environment variables template
├── .gitignore
└── README.md
```

---

## File Placement Summary

### Root Level Files (from your conversation)

**Placed at root:**

- `.claudeproject` → `/sobremesa-workspace/.claudeproject`

**Placed in `.claude/` (AI assistant context):**

- `NX.md` → Nx MCP server instructions
- `CONFIGURATION.md` → Configuration notes

**Placed in `docs/` (human documentation):**

- `ARCHITECTURE.md`, `AGENTS.md`, `WARMTH.md`, `CULTURE.md`, `IMPLEMENTATION.md`
- `adr/` → Architecture Decision Records

**Database schema:**

- `apps/db/supabase/migrations/` → Source of truth for schema

**Placed in `prompts/`:**

- `facilitator.txt` → `/sobremesa/prompts/facilitator.md`
- `admin.txt` → `/sobremesa/prompts/admin.md`
- `scribe.txt` → `/sobremesa/prompts/scribe.md`
- `curator.txt` → `/sobremesa/prompts/curator.md`

---

## Nx Library Dependencies

Visual dependency graph:

```
apps/chatbots
    ↓
    ├─→ libs/agents/facilitator
    ├─→ libs/agents/admin
    ├─→ libs/agents/scribe
    ├─→ libs/agents/curator
    ├─→ libs/agents/intern
    ├─→ libs/agents/registrar
    ├─→ libs/queue
    ├─→ libs/database
    ├─→ libs/telegram
    └─→ libs/config

libs/agents/intern (uses Haiku)
    ↓
    ├─→ libs/database (conversation_events, images)
    └─→ libs/shared/types

libs/agents/* (other agents use Sonnet)
    ↓
    ├─→ libs/claude-api
    ├─→ libs/prompts
    ├─→ libs/database
    └─→ libs/shared/types

libs/agents/registrar (no LLM)
    ↓
    ├─→ libs/database
    └─→ libs/shared/types

libs/queue
    ↓
    └─→ libs/database

libs/database
    ↓
    └─→ libs/shared/types

libs/prompts
    ↓
    ├─→ libs/config
    └─→ libs/shared/types
```

---

## Key Nx Commands

### Generate new library:

```bash
nx generate @nx/node:library agents/facilitator --directory=libs/agents
```

### Generate new app:

```bash
nx generate @nx/node:application chat provider-bot --directory=apps
```

### Build specific library:

```bash
nx build agents-facilitator
```

### Build entire project:

```bash
nx build chat provider-bot
```

### Run tests:

```bash
nx test agents-facilitator
nx test --all
```

### Dependency graph visualization:

```bash
nx graph
```

---

## Benefits of This Structure

### 1. Clear Separation

- **Apps**: Runnable applications (Chat Provider bot, API, dashboard)
- **Libs**: Reusable components (agents, database, queue)
- **Docs**: All documentation in one place
- **Prompts**: AI prompts separate and versioned

### 2. Nx Advantages

- **Incremental builds**: Only rebuild what changed
- **Dependency graph**: Visual understanding
- **Code sharing**: DRY across agents
- **Testing**: Test individual components
- **Monorepo tooling**: Unified commands

### 3. Scalability

- Add new agent easily (`nx g library agents/new-agent`)
- Add new app (dashboard, API) without affecting bot
- Shared types prevent drift
- Each library independently testable

### 4. Team Collaboration

- Clear ownership (each lib has owner)
- No merge conflicts (libs are separated)
- Can work on agents independently
- Shared utilities prevent duplication

---

## Environment Variables

Create `.env` at workspace root:

```bash
# Chat Provider
CHAT PROVIDER_BOT_TOKEN=your_token_here
CHAT PROVIDER_ADMIN_USER_ID=your_chat provider_id

# Anthropic
ANTHROPIC_API_KEY=your_anthropic_key

# Supabase
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key

# Queue (optional, for Redis)
REDIS_URL=redis://localhost:6379

# Web3 (optional)
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_WALLET_PRIVATE_KEY=your_private_key

# Environment
NODE_ENV=development
LOG_LEVEL=debug
```

---

## Getting Started

### 1. Create Nx workspace:

```bash
npx create-nx-workspace@latest sobremesa-workspace \
  --preset=ts \
  --packageManager=npm
```

### 2. Copy documentation files:

```bash
# Copy all files from outputs to workspace root
cp -r /path/to/.claudeproject sobremesa-workspace/
cp -r /path/to/.claude sobremesa-workspace/
cp -r /path/to/prompts sobremesa-workspace/
```

### 3. Generate initial libraries:

```bash
cd sobremesa-workspace

# Generate agent libraries
nx g @nx/node:library agents/facilitator --directory=libs
nx g @nx/node:library agents/admin --directory=libs
nx g @nx/node:library agents/scribe --directory=libs
nx g @nx/node:library agents/curator --directory=libs
nx g @nx/node:library agents/intern --directory=libs
nx g @nx/node:library agents/registrar --directory=libs

# Generate infrastructure libraries
nx g @nx/node:library database --directory=libs
nx g @nx/node:library queue --directory=libs
nx g @nx/node:library data-writer --directory=libs
nx g @nx/node:library config --directory=libs
nx g @nx/node:library prompts --directory=libs

# Generate utility libraries
nx g @nx/node:library claude-api --directory=libs
nx g @nx/node:library chat provider --directory=libs
nx g @nx/node:library shared/types --directory=libs
nx g @nx/node:library shared/utils --directory=libs

# Generate main app
nx g @nx/node:application chat provider-bot --directory=apps
```

### 4. Install dependencies:

```bash
npm install @anthropic-ai/sdk @supabase/supabase-js telegraf ioredis
npm install -D @types/node
```

### 5. Set up database:

```bash
# Run schema.sql on Supabase
# Copy apps/db/supabase/migrations/20260112074715_init_schema.sql to libs/database/src/migrations/
```

---

## Summary

This Nx monorepo structure gives you:

✅ **Clear organization** - Documentation, prompts, code all in their place  
✅ **Nx power** - Incremental builds, dependency graphs, shared code  
✅ **Scalability** - Add agents, apps, features independently  
✅ **Testability** - Each library tested in isolation  
✅ **Reusability** - Libraries used across multiple apps  
✅ **Team-ready** - Clear ownership, no conflicts

All your documentation and prompts are now positioned for Claude Code to start building!
