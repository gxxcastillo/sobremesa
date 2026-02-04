# Technology Stack

Technical specification for Sobremesa's implementation.

---

## Core Technologies

### Language & Runtime

- **TypeScript** 5.9.x (strict mode)
- **Node.js** 22 LTS
- **Package Manager:** bun

### Monorepo Framework

- **Nx** 22.x
- **Nx Plugins:**
  - `@nx/js` - TypeScript libraries
  - `@nx/node` - Node.js applications
  - `@nx/vite` - Build tooling (Studio)
  - `@nx/esbuild` - Build tooling (chatbots, API)
  - `@nx/eslint` - Linting
  - `@nx/vitest` - Testing

### Database

- **Supabase** (PostgreSQL)
  - Local development: Supabase CLI + Docker
  - Production: Supabase Cloud
- **Extensions Required:**
  - `pgcrypto` - UUID generation
  - `pg_trgm` - Fuzzy text matching for deduplication

### AI Integration

- **AI Provider Abstraction** (`libs/ai-provider`) - Pluggable provider system
  - `anthropic` - Anthropic Claude (production default)
  - `openai-compatible` - Ollama, LM Studio, etc. (local development)
  - `mock` - Mock provider for testing
- **Primary model:** Claude Sonnet 4 (Scribe, Historian, Facilitator, Admin, Curator)
- **Lightweight model:** Claude Haiku (Intern)
- **SDK:** `@anthropic-ai/sdk`

### Message Queue

- Database-backed queue (`processing_queue` table)
- Sequential per-family processing with lock/release
- Retry with exponential backoff, dead letter after 3 failures

### Chat Provider Integration

- **Telegram** via `telegraf` SDK
- Single bot handles ingestion, facilitation, and responses
- Webhook-based in production, polling in development

### Web UI

- **SolidJS** - Reactive web framework (Studio app)
- **Vite** - Build tool and dev server

---

## Development Tools

### Testing

- **Vitest** - Unit & integration tests
- **Workspace Config:** `vitest.workspace.ts`
- **Simulation:** `scripts/simulate-messages.ts` for end-to-end testing

### Linting & Formatting

- **ESLint** 8.x (flat config: `eslint.config.mjs`)
- **Prettier** for formatting

### Type Checking

- **TypeScript Compiler** (`tsc`)
- Strict mode enabled across all projects
- Path mapping via `tsconfig.base.json`

### Git Hooks

- **Husky** - Pre-commit hooks
- **lint-staged** - Run linters on staged files

---

## Project Structure

```
sobremesa/
├── apps/
│   ├── chatbots/             ← Telegram bot + queue worker
│   ├── api/                  ← REST API (Elysia)
│   ├── studio/               ← Web UI (SolidJS)
│   └── db/                   ← Database migrations
├── libs/
│   ├── agents/               ← All 7 AI agents
│   │   ├── scribe/           ← Entity/claim extraction
│   │   ├── registrar/        ← Database persistence
│   │   ├── facilitator/      ← Question asking
│   │   ├── historian/        ← Question answering
│   │   ├── intern/           ← Filtering & routing
│   │   ├── curator/          ← Image analysis
│   │   └── admin/            ← Celebrations, coaching
│   ├── ai-provider/          ← Multi-provider AI abstraction
│   ├── database/             ← Supabase client + repositories
│   ├── queue/                ← Message processing queue
│   ├── telegram/             ← Telegram bot management
│   ├── ingester/             ← Message ingestion
│   ├── api-client/           ← Shared API client
│   ├── auth/                 ← Authentication (JWT, access passes)
│   ├── prompts/              ← Agent prompt templates
│   └── shared/
│       ├── types/            ← Shared TypeScript types
│       └── utils/            ← Shared utilities (logger, etc.)
├── scripts/                  ← Development & testing scripts
└── __plans/                  ← Implementation plans
```

See [NX-MONOREPO-STRUCTURE.md](NX-MONOREPO-STRUCTURE.md) for detailed layout.

---

## Environment Variables

See `.env.example` for the canonical list.

**Required:**

```bash
# Database
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Claude API
ANTHROPIC_API_KEY=sk-ant-...

# Telegram
TELEGRAM_BOT_TOKEN=123:ABC

# Auth
ACCESS_PASS_SECRET=your-secret-key

# Studio
STUDIO_URL=https://sobremesa.x:3000
```

**Optional:**

```bash
# AI Provider overrides (per-agent)
AI_PROVIDER_DEFAULT=anthropic
AI_PROVIDER_SCRIBE=anthropic
AI_PROVIDER_INTERN=local

# Local LLM (OpenAI-compatible)
LOCAL_LLM_BASE_URL=http://um890.local:11434/v1
LOCAL_LLM_MODEL=llama3.2:latest

# Application
LOG_LEVEL=debug
```

---

## Database Setup

### Local Development

```bash
# Start local Supabase (PostgreSQL + Studio)
supabase start

# Apply schema
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  -f apps/db/supabase/migrations/20260112074715_init_schema.sql
```

### Production

1. Create Supabase project at https://supabase.com
2. Apply schema migration via SQL Editor or `supabase db push`
3. Enable Row Level Security (RLS) policies (see [DATA-ISOLATION.md](DATA-ISOLATION.md))

---

## API Integrations

### AI Provider Setup

```typescript
import { loadAIConfig, createAIProviderFactory } from '@sobremesa/ai-provider';

// Load config from environment (AI_PROVIDER_DEFAULT, per-agent overrides)
const aiConfig = loadAIConfig();
const providerFactory = createAIProviderFactory(aiConfig);

// Get provider for a specific agent
const scribeProvider = providerFactory.getProvider('scribe');
const response = await scribeProvider.complete({
  model: aiConfig.agents.scribe.model,
  messages: [{ role: 'user', content: prompt }],
  maxTokens: 4096,
});
```

### Telegram Bot Setup

```typescript
import { BotManager } from '@sobremesa/telegram';

const botManager = new BotManager({
  token: process.env.TELEGRAM_BOT_TOKEN,
});
```

---

## Build & Development

```bash
# Install dependencies
bun install

# Start chatbot locally
nx dev chatbots

# Start Studio web app
nx dev studio

# Run all checks
bun check:all           # lint + types + test

# Run specific tests
nx test agents-scribe
nx test agents-registrar

# Build for production
nx build chatbots
nx build api
```

---

## Performance Considerations

### Rate Limits

**Claude API:**

- Implement exponential backoff via ai-provider
- Queue requests if hitting limits

**Telegram API:**

- 30 messages/second per bot
- Rate limiting built into BotManager

### Database Optimization

**Indexes:**

- `family_id` on ALL tables (primary isolation boundary)
- Composite indexes for common queries
- `pg_trgm` for fuzzy text matching

### Caching Strategy

**What to cache:** Configuration (TTL: 1 hour), cultural terms (TTL: 24 hours)

**What NOT to cache:** Messages, real-time levers, pending questions

---

## Security

- **JWT authentication** for Studio web app
- **Row Level Security (RLS)** on all database tables
- **Service role key** only in backend (never client-side)
- **Access passes** for bot → web handoff (24hr expiry, single-use)
- **Environment variables** for all secrets (never committed)

---

## Monitoring & Logging

### Structured Logging

```typescript
import { createLogger } from '@sobremesa/shared-utils';

const logger = createLogger({ name: 'scribe', level: 'info' });
logger.info({ familyId, eventId }, 'Processing message');
logger.error({ err: error, familyId }, 'Failed to extract claims');
```

Uses `pino` with structured JSON output. Use `pino-pretty` for readable dev output.

---

## Dependencies

Key production dependencies (see `package.json` for full list):

```
@anthropic-ai/sdk     - Claude API client
@supabase/supabase-js - Database client
telegraf               - Telegram bot framework
pino                   - Structured logging
zod                    - Schema validation
solid-js               - UI framework (Studio)
dotenv                 - Environment variable loading
```

---

## See Also

- [QUICKSTART.md](QUICKSTART.md) - Getting started guide
- [NX-MONOREPO-STRUCTURE.md](NX-MONOREPO-STRUCTURE.md) - Detailed workspace layout
- [ARCHITECTURE.md](ARCHITECTURE.md) - System architecture
