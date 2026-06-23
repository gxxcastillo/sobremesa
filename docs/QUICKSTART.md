# Quick Start Guide

Get Sobremesa running locally.

---

## Prerequisites

- **Node.js** 22 LTS ([Download](https://nodejs.org/))
- **bun** - `curl -fsSL https://bun.com/install | bash`
- **Supabase CLI** - `brew install supabase/tap/supabase` (for local dev)
- **Claude API Key** - [console.anthropic.com](https://console.anthropic.com/)
- **Telegram Bot** - Create via [@BotFather](https://t.me/botfather)

---

## Step 1: Clone & Install

```bash
cd sobremesa
bun install
```

---

## Step 2: Create Telegram Bot

Open Telegram and message [@BotFather](https://t.me/botfather):

```
/newbot
Name: Sobremesa
Username: your_sobremesa_bot
```

Save the token. Then disable Privacy Mode so the bot can read group messages:

```
/mybots → Select your bot → Bot Settings → Group Privacy → Turn off
```

Sobremesa uses a **single bot** for all agent interactions (ingestion, facilitation, question answering).

---

## Step 3: Supabase Setup

### Local Development (Recommended)

```bash
# Start local Supabase (PostgreSQL + Studio)
supabase start

# Apply schema
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  -f apps/db/supabase/migrations/20260112074715_init_schema.sql
```

Local Supabase provides:

- **SUPABASE_URL**: `http://127.0.0.1:54321`
- **SUPABASE_ANON_KEY**: printed by `supabase start`
- **SUPABASE_SERVICE_ROLE_KEY**: printed by `supabase start`

### Cloud Development

1. Go to [supabase.com](https://supabase.com/) and create a project
2. From Project Settings > API, get the URL, anon key, and service role key
3. Apply schema via SQL Editor (paste contents of `apps/db/supabase/migrations/20260112074715_init_schema.sql`)

---

## Step 4: Environment Variables

Copy `.env.example` to `.env` and fill in values:

```bash
cp .env.example .env
```

Required variables:

```bash
# Supabase
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Claude API
ANTHROPIC_API_KEY=sk-ant-...

# Telegram Bot
TELEGRAM_BOT_TOKEN=123456789:AAF...

# Access Pass Secret (for JWT signing)
ACCESS_PASS_SECRET=your-secret-here

# Studio URL (for access pass links)
STUDIO_URL=https://sobremesa.x:3000
```

See `.env.example` for optional settings (local LLM, per-agent provider overrides).

---

## Step 5: Create Telegram Group

1. Create a new Telegram group
2. Add the bot to the group
3. Make sure the bot has permission to read messages (Privacy Mode disabled in Step 2)

---

## Step 6: Start the Chatbot

```bash
bun nx dev chatbots
```

The bot will auto-create a family record when it receives its first message in a group.

---

## Step 7: Test Message Flow

Send a message in the group:

```
My grandmother Rosa came to America from Poland in 1920.
```

**Expected behavior:**

1. Bot ingests message into `conversation_events`
2. Intern filters (relevant → pass to Scribe)
3. Scribe extracts: Rosa (person), Poland (place), America (place), immigration (event), claims with provenance
4. Registrar persists entities, claims, and links to database

### Verify in Database

Check Supabase tables (via Studio at `http://127.0.0.1:54323` for local):

- `conversation_events` - Should have your message
- `people` - Should have "Rosa"
- `places` - Should have "America" and "Poland"
- `timeline_events` - Should have immigration event
- `claims` - Should have claims with provenance

### Run Summary

```bash
bun scripts/summary.ts
```

---

## Common Commands

```bash
# Start the chatbot
bun nx dev chatbots

# Build everything
bun nx build chatbots

# Run summary for a family
bun scripts/summary.ts

# Simulate test messages (without a real Telegram group)
bun scripts/simulate-messages.ts                    # list scenarios
bun scripts/simulate-messages.ts trip-story --reset  # run scenario

# Debug tools
bun scripts/debug-facilitator.ts
bun scripts/show-queue.ts
bun scripts/dump-db.ts <family-id>

# Run tests
bun check:all
```

---

## Troubleshooting

### Bot not receiving messages

1. Check bot is added to group
2. Check Privacy Mode is **disabled** (BotFather → Bot Settings → Group Privacy → Turn off)
3. Verify `TELEGRAM_BOT_TOKEN` in `.env`
4. Check logs: `bun nx dev chatbots`

### Database connection failed

1. Verify Supabase is running: `supabase status`
2. Check `SUPABASE_URL` format
3. Check service role key (not anon key) for writes

### Claude API errors

1. Verify `ANTHROPIC_API_KEY`
2. Check API credits at console.anthropic.com
3. Check rate limits

### No entities extracted

1. Check `ANTHROPIC_API_KEY` is valid
2. Check logs for Scribe errors
3. Test extraction with simulation: `bun scripts/simulate-messages.ts ralphy-shoes --reset`

---

## Project Structure

```
apps/
  chatbots/               # Main application entry point
  studio/                 # Web UI (SolidJS)
  api/                    # REST API (Elysia)
  db/                     # Database migrations

libs/
  agents/
    scribe/               # Entity/claim extraction (Sonnet)
    registrar/            # Database persistence (no LLM)
    facilitator/          # Question asking & response formatting
    historian/            # Question answering from database
    intern/               # Message filtering & routing (Haiku)
    curator/              # Image analysis
    admin/                # Celebrations, mediation, coaching
  ai-provider/            # Multi-provider AI abstraction
  database/               # Supabase client + repositories
  queue/                  # Message processing queue
  telegram/               # Telegram bot management
  ingester/               # Message ingestion
  api-client/             # Shared API client
  auth/                   # Authentication (JWT, access passes)
  prompts/                # Agent prompt templates
  shared/
    types/                # TypeScript types
    utils/                # Shared utilities

scripts/
  simulate-messages.ts    # Test scenarios without Telegram
  summary.ts              # Show family knowledge
  dump-db.ts              # Export family data as JSON
  debug-facilitator.ts    # Debug facilitator decisions
```

---

## Next Steps

Once basic flow is working:

1. **Send family messages** - The more context, the better extraction
2. **Check summary** - Run `bun scripts/summary.ts` periodically
3. **Try simulation** - Run `bun scripts/simulate-messages.ts family-history --reset --dump` for a rich test scenario

---

## Getting Help

1. Check logs: `bun nx dev chatbots`
2. Check `event_log` table in Supabase
3. Run debug scripts in `scripts/`
4. Review [ARCHITECTURE.md](ARCHITECTURE.md) for system design
