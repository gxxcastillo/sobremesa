# Quick Start Guide

Get Sobremesa running locally in under 30 minutes.

---

## Prerequisites

- **Node.js** 22 LTS ([Download](https://nodejs.org/))
- **pnpm** - `npm install -g pnpm`
- **Supabase Account** - [supabase.com](https://supabase.com/) (free tier works)
- **Claude API Key** - [console.anthropic.com](https://console.anthropic.com/)
- **Telegram Bots** - Create via [@BotFather](https://t.me/botfather)

---

## Step 1: Clone & Install

```bash
cd sobremesa
pnpm install
```

---

## Step 2: Create Telegram Bots

Open Telegram and message [@BotFather](https://t.me/botfather):

1. **Create Scribe Bot** (required)
   ```
   /newbot
   Name: Sobremesa Scribe
   Username: sobremesa_scribe_bot
   ```
   Save the token.

2. **Create Facilitator Bot** (required for questions)
   ```
   /newbot
   Name: Sobremesa Facilitator
   Username: sobremesa_facilitator_bot
   ```
   Save the token.

3. **Create Admin Bot** (optional)
   ```
   /newbot
   Name: Sobremesa Admin
   Username: sobremesa_admin_bot
   ```
   Save the token.

---

## Step 3: Supabase Setup

### Create Project

1. Go to [supabase.com](https://supabase.com/)
2. Create new project
3. Wait for project to initialize

### Get Connection Info

From Project Settings > API:
- **Project URL** (SUPABASE_URL)
- **anon public** key (SUPABASE_ANON_KEY)
- **service_role** key (SUPABASE_SERVICE_ROLE_KEY)

### Apply Schema

1. Go to SQL Editor in Supabase dashboard
2. Copy contents of `.claude/SCHEMA.sql`
3. Run the query

### Create Test Family

Run this SQL:

```sql
INSERT INTO families (name, config, is_active)
VALUES (
  'My Family',
  '{"languages": {"primary": "en"}}'::jsonb,
  true
);
```

Note the family ID from the result.

---

## Step 4: Environment Variables

Create `.env` in project root:

```bash
# Supabase
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# Claude API
ANTHROPIC_API_KEY=sk-ant-api03-...

# Telegram Bots
TELEGRAM_BOT_TOKEN_SCRIBE=123456789:AAF...
TELEGRAM_BOT_TOKEN_FACILITATOR=123456789:BBG...
TELEGRAM_BOT_TOKEN_ADMIN=123456789:CCH...
```

---

## Step 5: Create Telegram Group

1. Create a new Telegram group
2. Add all three bots to the group
3. Make sure bots have permission to read messages

---

## Step 6: Register the Family

1. Start the gateway:
   ```bash
   nx serve chatbots
   ```

2. In the Telegram group, send:
   ```
   /register YOUR_FAMILY_ID
   ```
   (Use the family ID from Step 3)

3. You should see a confirmation message

---

## Step 7: Test Message Flow

Send a message in the group:
```
My grandmother Rosa came to America from Poland in 1920.
```

**Expected behavior:**
1. Scribe bot ingests message
2. Claude extracts: Rosa (person), Poland (place), America (place), immigration (event)
3. Questions generated about gaps
4. Facilitator may ask a follow-up question

### Verify in Database

Check Supabase tables:
- `conversation_events` - Should have your message
- `people` - Should have "Rosa" and "grandmother"
- `places` - Should have "America" and "Poland"
- `events` - Should have immigration event
- `questions` - Should have follow-up questions

### Run Summary

```bash
npx tsx scripts/summary.ts
```

This shows everything captured so far.

---

## Common Commands

```bash
# Start the gateway
nx serve chatbots

# Build everything
nx build chatbots

# Run summary
npx tsx scripts/summary.ts

# Test Scribe extraction
npx tsx scripts/test-scribe.ts

# Send a question manually
npx tsx scripts/test-send-question.ts

# Check answer detection status
npx tsx scripts/test-answer-detection.ts

# Debug Facilitator
npx tsx scripts/debug-facilitator.ts
```

---

## Troubleshooting

### Bot not receiving messages

1. Check bot is added to group
2. Check bot has message permission (BotFather settings)
3. Verify token in `.env`
4. Check logs: `nx serve chatbots`

### Database connection failed

1. Verify SUPABASE_URL format: `https://xxx.supabase.co`
2. Check service role key (not anon key) for writes
3. Verify project is running in Supabase dashboard

### Claude API errors

1. Verify ANTHROPIC_API_KEY
2. Check API credits at console.anthropic.com
3. Check rate limits

### Questions not being asked

1. Check TELEGRAM_BOT_TOKEN_FACILITATOR is set
2. Run `npx tsx scripts/debug-facilitator.ts`
3. Check rate limiting (5 min default between questions)
4. Verify questions exist: `SELECT * FROM questions`

### No entities extracted

1. Check ANTHROPIC_API_KEY is valid
2. Check logs for Scribe errors
3. Run `npx tsx scripts/test-scribe.ts` to test extraction

---

## Project Structure

```
apps/
  chatbots/     # Main application entry point

libs/
  agents/
    scribe/                 # Claude-powered extraction
    registrar/              # Database persistence
    facilitator/            # Question asking
  database/                 # Supabase repositories
  queue/                    # Message processing
  telegram/                 # Bot management
  shared/
    types/                  # TypeScript types
    utils/                  # Shared utilities

scripts/
  summary.ts                # Show family knowledge
  test-scribe.ts            # Test extraction
  test-facilitator.ts       # Test question asking
  test-send-question.ts     # Send real question
  debug-facilitator.ts      # Debug issues
```

---

## Next Steps

Once basic flow is working:

1. **Send family messages** - The more context, the better extraction
2. **Answer questions** - Reply to Facilitator questions to mark them answered
3. **Check summary** - Run `npx tsx scripts/summary.ts` periodically
4. **Adjust rate limiting** - Edit `minMinutesBetweenQuestions` in main.ts

See [IMPLEMENTATION.md](IMPLEMENTATION.md) for full feature roadmap.

---

## Getting Help

1. Check logs: `nx serve chatbots`
2. Check event_log table in Supabase
3. Run debug scripts in `scripts/`
4. Review [ARCHITECTURE.md](ARCHITECTURE.md) for system design
