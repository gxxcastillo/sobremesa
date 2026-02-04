# Nx Monorepo Structure

Sobremesa's actual workspace layout and Nx configuration.

---

## Workspace Structure

```
sobremesa/
├── .claude/                          ← AI assistant context
│   ├── CONFIGURATION.md
│   └── settings.local.json
│
├── docs/                             ← Human documentation
│   ├── ARCHITECTURE.md
│   ├── AGENTS.md
│   ├── WARMTH.md
│   ├── CULTURE.md
│   └── adr/                          ← Architecture Decision Records
│
├── apps/                             ← Nx applications
│   ├── chatbots/                     ← Main entry point (Telegram bot + queue worker)
│   │   ├── src/
│   │   │   └── main.ts              ← Entry point
│   │   └── project.json
│   │
│   ├── api/                          ← REST API (Elysia)
│   │   └── ...
│   │
│   ├── studio/                       ← Web UI (SolidJS + Vite)
│   │   └── ...
│   │
│   └── db/                           ← Database
│       └── supabase/
│           └── migrations/
│               └── 20260112074715_init_schema.sql
│
├── libs/                             ← Nx libraries (reusable)
│   │
│   ├── agents/                       ← All AI agents
│   │   ├── scribe/                   ← Entity/claim extraction (Sonnet)
│   │   ├── registrar/                ← Database persistence (no LLM)
│   │   ├── facilitator/              ← Question asking + response formatting
│   │   ├── historian/                ← Question answering from database
│   │   ├── intern/                   ← Message filtering & routing (Haiku)
│   │   ├── curator/                  ← Image analysis
│   │   └── admin/                    ← Celebrations, mediation, coaching
│   │
│   ├── ai-provider/                  ← Multi-provider AI abstraction
│   │   ├── src/lib/
│   │   │   ├── provider.interface.ts
│   │   │   ├── types.ts
│   │   │   ├── factory.ts
│   │   │   ├── config.ts
│   │   │   └── providers/
│   │   │       ├── anthropic.ts
│   │   │       ├── openai-compatible.ts
│   │   │       └── mock.ts
│   │   └── project.json
│   │
│   ├── database/                     ← Supabase client + repositories
│   │   ├── src/lib/
│   │   │   ├── client.ts
│   │   │   ├── base-repository.ts
│   │   │   └── repositories/        ← Per-table data access
│   │   └── project.json
│   │
│   ├── queue/                        ← Message processing queue
│   │   └── project.json
│   │
│   ├── telegram/                     ← Telegram bot management (Telegraf)
│   │   └── project.json
│   │
│   ├── ingester/                     ← Message ingestion (provider-agnostic)
│   │   └── project.json
│   │
│   ├── api-client/                   ← Shared API client
│   │   └── project.json
│   │
│   ├── auth/                         ← Authentication (JWT, access passes)
│   │   └── project.json
│   │
│   ├── prompts/                      ← Agent prompt templates
│   │   ├── src/agents/
│   │   │   ├── scribe.txt
│   │   │   ├── facilitator.txt
│   │   │   ├── facilitator-response.txt
│   │   │   ├── historian.txt
│   │   │   ├── admin.txt
│   │   │   ├── curator.txt
│   │   │   ├── intern-filter.txt
│   │   │   └── intern-image-link.txt
│   │   └── project.json
│   │
│   └── shared/                       ← Shared utilities
│       ├── types/                    ← Shared TypeScript types
│       │   ├── src/lib/
│       │   │   ├── domain-model.ts
│       │   │   ├── confidence.ts
│       │   │   ├── languages.ts
│       │   │   ├── relationships.ts
│       │   │   └── conversation.ts
│       │   └── project.json
│       │
│       └── utils/                    ← Shared utilities
│           ├── src/lib/
│           │   └── logger.ts
│           └── project.json
│
├── scripts/                          ← Development & testing scripts
│   ├── simulate-messages.ts          ← Feed test scenarios into pipeline
│   ├── summary.ts                    ← Show family knowledge
│   ├── dump-db.ts                    ← Export family data as JSON
│   ├── reset-db.ts                   ← Reset database
│   ├── debug-facilitator.ts          ← Debug facilitator decisions
│   ├── show-queue.ts                 ← Show queue status
│   └── tests/                        ← Agent-specific test scripts
│
├── __plans/                          ← Implementation plans
│
├── package.json                      ← Root package.json (bun workspaces)
├── nx.json                           ← Nx configuration
├── tsconfig.base.json                ← Base TypeScript config
├── .env.example                      ← Environment variables template
└── .gitignore
```

---

## Nx Library Dependencies

```
apps/chatbots
    ↓
    ├─→ libs/agents/* (all 7 agents)
    ├─→ libs/queue
    ├─→ libs/database
    ├─→ libs/telegram
    ├─→ libs/ingester
    └─→ libs/ai-provider

apps/api
    ↓
    ├─→ libs/database
    ├─→ libs/auth
    ├─→ libs/api-client
    └─→ libs/shared/types

apps/studio
    ↓
    └─→ libs/api-client

libs/agents/scribe
    ↓
    ├─→ libs/ai-provider
    ├─→ libs/prompts
    ├─→ libs/database
    └─→ libs/shared/types

libs/agents/registrar (no LLM)
    ↓
    ├─→ libs/database
    └─→ libs/shared/types

libs/agents/intern
    ↓
    ├─→ libs/database
    └─→ libs/shared/types

libs/database
    ↓
    └─→ libs/shared/types

libs/queue
    ↓
    └─→ libs/database
```

---

## Key Nx Commands

```bash
# Development
nx dev chatbots                   # Start chatbot with watch mode
nx dev api                        # Start API server
nx dev studio                     # Start Studio web app

# Building
nx build chatbots                 # Build chatbot
nx build api                      # Build API

# Testing
nx test agents-scribe             # Test single library
bun test:all                      # Run all tests
bun types:all                     # Type-check all projects
bun check:all                     # Lint + types + test

# Dependency graph
nx graph                          # Visualize dependencies
```

---

## Workspace Configuration

**Package manager:** bun (workspaces defined in `package.json`)

**Nx version:** 22.x

**Nx plugins:**

- `@nx/js` - TypeScript libraries
- `@nx/node` - Node.js applications
- `@nx/vite` - Build tooling (Studio)
- `@nx/esbuild` - Build tooling (chatbots, API)
- `@nx/eslint` - Linting
- `@nx/vitest` - Testing

**TypeScript:** 5.9.x with strict mode, path mapping via `tsconfig.base.json`

---

## Environment Variables

See `.env.example` for the canonical list. Key variables:

```bash
# Required
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=123:ABC
ACCESS_PASS_SECRET=...
STUDIO_URL=https://sobremesa.x:3000

# Optional (multi-provider AI)
AI_PROVIDER_DEFAULT=anthropic
LOCAL_LLM_BASE_URL=http://um890.local:11434/v1
LOCAL_LLM_MODEL=llama3.2:latest
```

---

## See Also

- [QUICKSTART.md](QUICKSTART.md) - Getting started guide
- [TECH-STACK.md](TECH-STACK.md) - Technology stack details
- [ARCHITECTURE.md](ARCHITECTURE.md) - System architecture
