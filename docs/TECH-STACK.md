# Technology Stack

Complete technical specification for Sobremesa implementation.

---

## Core Technologies

### Language & Runtime

- **TypeScript** 5.x (latest stable)
- **Node.js** 22 LTS
- **Package Manager:** pnpm

### Monorepo Framework

- **Nx** 22+ (latest stable)
- **Nx Plugins:**
  - `@nx/js` - TypeScript libraries
  - `@nx/node` - Node.js applications
  - `@nx/vite` - Build tooling
  - `@nx/eslint` - Linting

### Database

- **Supabase** (PostgreSQL 14+)
  - Local development: Supabase CLI + Docker
  - Production: Supabase Cloud
- **Extensions Required:**
  - `pgcrypto` - UUID generation
  - `pg_trgm` (optional) - Fuzzy text matching for deduplication

### AI Integration

- **Anthropic Claude API**
  - Primary model: Claude 3.5 Sonnet (or latest)
  - Vision model: Claude 3.5 Sonnet (for Curator)
- **SDK:** `@anthropic-ai/sdk`

### Message Queue

**For POC/MVP:**

- In-memory queue (simple array-based)
- Persisted to database (`message_queue` table)

**For Production:**

- **Redis** (recommended)
- Alternative: **BullMQ** (Redis-based job queue)

### Chat Provider Integration

- **Pluggable chat providers** - Telegram, WhatsApp, SMS, etc.
- **Provider-specific SDKs** as needed
- Webhook or polling-based message ingestion

### Translation (Optional)

- **DeepL API** (higher quality than Claude for pure translation)
- Alternative: Claude API (multi-modal, can translate + preserve cultural terms)

### Blockchain (Optional)

- **Solana** @solana/kit (https://www.solanakit.com/)
- Only if `config.web3Enabled = true`
- Non-blocking async writes

---

## Development Tools

### Bundling

- **Vite** - Fast build tool and development server

### Testing

- **Vitest** - Unit & integration tests
- **Workspace Config:** `vitest.workspace.ts` (already present)
- Coverage target: 70%+ for core libraries

### Linting & Formatting

- **ESLint** 9+ (flat config: `eslint.config.mjs`)
- **Prettier** (optional, personal preference)

### Type Checking

- **TypeScript Compiler** (`tsc`)
- Strict mode enabled across all projects
- Path mapping via `tsconfig.base.json`

### Git Hooks (Optional)

- **Husky** - Pre-commit hooks
- **lint-staged** - Run linters on staged files

### UI

- **SolidJs** (for building reactive user interfaces)

---

## Project Structure

```
sobremesa/
├── apps/
│   └── chatbots/  ← Telegram ingestion/orchestration app
├── libs/
│   ├── agents/                ← Facilitator, Admin, Scribe, Curator
│   │   ├── facilitator/
│   │   ├── admin/
│   │   ├── scribe/
│   │   └── curator/
│   ├── database/              ← Supabase client + repositories
│   ├── queue/                 ← Message queue abstraction
│   ├── domain/                ← Shared domain models & types
│   ├── config/                ← Configuration loading & validation
│   ├── translation/           ← Translation utilities
│   ├── ui/                    ← User interface components
│   ├── utils/                 ← Utility functions
│   └── web3/                  ← Blockchain integration (optional)
├── scripts/                   ← Automation scripts
└── tools/                     ← Development tools
```

---

## Environment Variables

**Required:**

```bash
# Database
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key  # For backend only

# Claude API
ANTHROPIC_API_KEY=sk-ant-...

# Chat Provider
CHAT_PROVIDER_TYPE=telegram  # or whatsapp, sms, etc.
CHAT_PROVIDER_BOT_TOKEN=your-bot-token

# Application
NODE_ENV=development|production
LOG_LEVEL=debug|info|warn|error
FAMILY_ID=uuid-of-family  # For single-family deployments
```

**Optional:**

```bash
# Translation
DEEPL_API_KEY=your-deepl-key

# Redis (if using)
REDIS_URL=redis://localhost:6379

# Solana (if web3 enabled)
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_PRIVATE_KEY=base58-encoded-key
```

---

## Database Setup

### Local Development

```bash
# Install Supabase CLI
npm install -g supabase

# Initialize Supabase
supabase init

# Start local Supabase (PostgreSQL + Studio)
supabase start

# Apply schema
supabase db reset --db-url postgresql://postgres:postgres@localhost:54322/postgres
# OR
psql -h localhost -p 54322 -U postgres -d postgres -f .claude/SCHEMA.sql
```

### Production

1. Create Supabase project at https://supabase.com
2. Run schema migration:
   ```bash
   supabase db push
   ```
3. Enable Row Level Security (RLS) policies (see DATA-ISOLATION.md)

---

## API Integrations

### Claude API Setup

```typescript
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// For Scribe, Facilitator, Admin
const response = await anthropic.messages.create({
  model: 'claude-3-5-sonnet-20241022',
  max_tokens: 4000,
  messages: [{ role: 'user', content: prompt }],
});

// For Curator (vision)
const visionResponse = await anthropic.messages.create({
  model: 'claude-3-5-sonnet-20241022',
  max_tokens: 2000,
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: base64Image,
          },
        },
        { type: 'text', text: 'Analyze this family photo...' },
      ],
    },
  ],
});
```

### Chat Provider Bot Setup

**Example (Telegram):**

```typescript
import TelegramBot from 'node-telegram-bot-api';

const bot = new TelegramBot(process.env.CHAT_PROVIDER_BOT_TOKEN, {
  polling: true,
});

bot.on('message', async (msg) => {
  // Store in database
  await storeMessage(msg);

  // Add to queue
  await queueMessage(msg.message_id);
});
```

---

## Queue System Design

### In-Memory (POC)

```typescript
class MessageQueue {
  private queue: Map<string, string[]> = new Map(); // family_id -> message_ids

  async enqueue(familyId: string, messageId: string) {
    const familyQueue = this.queue.get(familyId) || [];
    familyQueue.push(messageId);
    this.queue.set(familyId, familyQueue);
  }

  async dequeue(familyId: string): Promise<string | null> {
    const familyQueue = this.queue.get(familyId);
    return familyQueue?.shift() || null;
  }
}
```

### Redis (Production)

```typescript
import Redis from 'ioredis';
import Queue from 'bull';

const redis = new Redis(process.env.REDIS_URL);

const messageQueue = new Queue('message-processing', {
  redis: process.env.REDIS_URL,
});

messageQueue.process(async (job) => {
  const { familyId, messageId } = job.data;
  await processMessage(familyId, messageId);
});
```

---

## Build & Deployment

### Development

```bash
# Install dependencies
pnpm install

# Run bot locally
nx serve telegram-bot

# Run tests
nx test agents-scribe
nx test agents-facilitator

# Lint
nx lint telegram-bot
```

### Production Build

```bash
# Build all projects
nx build telegram-bot --prod

# Output: dist/apps/telegram-bot
```

### Deployment Options

**Option 1: Docker**

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY dist/apps/telegram-bot .
CMD ["node", "main.js"]
```

**Option 2: Serverless**

- AWS Lambda + API Gateway (webhook)
- Vercel Serverless Functions
- Railway, Render, Fly.io

---

## Performance Considerations

### Rate Limits

**Claude API:**

- Tier 2: 50 requests/min
- Implement exponential backoff
- Queue requests if hitting limits

**Chat Provider API:**

- 30 messages/second per bot
- Use message batching where possible

### Database Optimization

**Indexes (from schema):**

- `family_id` on ALL tables
- `source_message_id` on claims
- `status` on questions
- Composite indexes for common queries

**Query Optimization:**

- Use database views for complex joins
- Limit context loading (5 full + 15 summaries)
- Paginate event log queries

### Caching Strategy

**What to cache:**

- Configuration (TTL: 1 hour)
- Facilitator rules (TTL: 10 minutes)
- Cultural terms (TTL: 24 hours)

**What NOT to cache:**

- Messages (always fresh)
- Real-time levers (immediate)
- Pending questions (stale risky)

---

## Security Considerations

### Environment Variables

- **Never commit** `.env` files
- Use secret management (Vercel Secrets, AWS Secrets Manager)
- Rotate API keys regularly

### Database Security

- **Row Level Security (RLS)** enabled on all tables
- Service role key only in backend (never client)
- Validate all inputs (prevent SQL injection)

### API Keys

- Restrict Claude API key to backend only
- Use separate keys per environment (dev/staging/prod)

---

## Monitoring & Logging

### Structured Logging

```typescript
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
});

logger.info({ familyId, messageId, agent: 'scribe' }, 'Processing message');
logger.error({ error, familyId }, 'Failed to save claim');
```

### Metrics to Track

- Messages processed per hour
- Queue depth per family
- Question ask rate
- Question answer rate
- Claude API latency
- Database write latency

### Error Tracking

- **Sentry** (recommended)
- **LogRocket** (optional)
- Custom event log queries

---

## Dependencies Summary

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.30.0",
    "@supabase/supabase-js": "^2.39.0",
    "telegraf": "^4.16.0",
    "ioredis": "^5.3.2",
    "bull": "^4.12.0",
    "zod": "^3.22.4",
    "pino": "^8.17.0"
  },
  "devDependencies": {
    "@nx/js": "^22.0.0",
    "@nx/node": "^22.0.0",
    "@nx/vite": "^22.0.0",
    "typescript": "^5.3.3",
    "vitest": "^1.2.0",
    "@types/node": "^22.0.0"
  }
}
```

---

## Next Steps

1. ✅ Read this tech stack doc
2. → Read QUICKSTART.md (to be created)
3. → Set up local development environment
4. → Initialize Nx workspace structure
5. → Apply database schema
6. → Implement Phase 1 (Foundation)
