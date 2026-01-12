# Quick Start Guide

Get Sobremesa running locally in under 30 minutes.

---

## Prerequisites

- **Node.js** 22 LTS ([Download](https://nodejs.org/))
- **pnpm** (or npm) - `npm install -g pnpm`
- **Docker** ([Download](https://www.docker.com/)) - For local Supabase
- **Supabase CLI** - `npm install -g supabase`
- **Claude API Key** - [Get from Anthropic](https://console.anthropic.com/)
- **Chat Provider Bot** - Set up bot with your chosen chat platform (Telegram, WhatsApp, etc.)

---

## Step 1: Clone & Install

```bash
cd sobremesa
pnpm install
```

---

## Step 2: Database Setup

### Start Local Supabase

```bash
# Initialize Supabase project
supabase init

# Start local PostgreSQL + Studio
supabase start
```

**Expected output:**
```
Started supabase local development setup.

         API URL: http://localhost:54321
          DB URL: postgresql://postgres:postgres@localhost:54322/postgres
      Studio URL: http://localhost:54323
```

### Apply Schema

```bash
# Option 1: Using Supabase CLI
supabase db reset

# Option 2: Using psql
psql -h localhost -p 54322 -U postgres -d postgres -f .claude/SCHEMA.sql
```

### Verify Tables Created

Open Supabase Studio: http://localhost:54323

You should see tables:
- `families`
- `conversation_events` (raw message ingestion)
- `claims`
- `people`
- `places`
- `events`
- `stories`
- `questions`
- `facilitator_rules`
- `real_time_levers`
- `event_log`
- etc.

---

## Step 3: Environment Variables

Create `.env` file in workspace root:

```bash
# Database (from `supabase start` output)
SUPABASE_URL=http://localhost:54321
SUPABASE_ANON_KEY=your-anon-key-from-supabase-start
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-from-supabase-start

# Claude API
ANTHROPIC_API_KEY=sk-ant-your-key-here

# Chat Provider Bot
CHAT_PROVIDER_BOT_TOKEN=your-bot-token

# Application
NODE_ENV=development
LOG_LEVEL=debug
```

**How to get keys:**

1. **Supabase keys**: Shown in `supabase start` output
2. **Claude API key**: https://console.anthropic.com/settings/keys
3. **Chat Provider token**: From your chat platform's bot setup

---

## Step 4: Seed Database

Create a test family:

```bash
# Connect to local database
psql -h localhost -p 54322 -U postgres -d postgres

# Insert test family
INSERT INTO families (id, name, config) 
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Test Family',
  '{
    "languages": {
      "primary": "en",
      "secondary": ["es"]
    },
    "bots": {
      "facilitator": {
        "displayName": "Annie",
        "personality": {
          "formality": "friendly",
          "verbosity": "moderate",
          "emojiUsage": "moderate"
        }
      }
    }
  }'::jsonb
);

# Insert initial facilitator rules
INSERT INTO facilitator_rules (family_id, max_questions_per_window, current_signal)
VALUES ('00000000-0000-0000-0000-000000000001', 2, 'neutral');

# Insert initial real-time levers
INSERT INTO real_time_levers (family_id)
VALUES ('00000000-0000-0000-0000-000000000001');

\q
```

---

## Step 5: Run the Bot

```bash
# Start conversation gateway
nx serve conversation-gateway

# OR for specific family
FAMILY_ID=00000000-0000-0000-0000-000000000001 nx serve conversation-gateway
```

**Expected output:**
```
Sobremesa bot started
Listening for messages...
Family ID: 00000000-0000-0000-0000-000000000001
```

---

## Step 6: Test the Bot

### 6.1 Create Chat Provider Group

1. Open Chat Provider
2. Create new group chat
3. Add the bot (use bot username from @BotFather)

### 6.2 Send Test Message

```
Hey everyone, I just remembered something about Grandpa...
```

**Expected behavior:**
1. Message stored in `conversation_events` table
2. Message added to queue
3. Scribe processes message (extracts entities)
4. Registrar saves to database
5. Check Supabase Studio for new records

### 6.3 Check Database

Open Studio: http://localhost:54323

Check tables:
- `conversation_events` - Should have 1 row (raw message)
- `claims` - May have rows if Scribe extracted facts
- `people` - May have row for "Grandpa"
- `event_log` - Should have processing events

---

## Step 7: Verify Question Flow

### Send a Story

```
My grandfather owned a small store in the village. 
He would wake up at 5am every day to open it.
```

**Expected:**
1. Scribe extracts story
2. Scribe detects gaps (which village? what year? what kind of store?)
3. Questions saved to `questions` table
4. Facilitator checks if should ask
5. If conditions met, bot asks warm question:

```
Annie: This is such a beautiful memory! If you happen to remember, 
what village was the store in? No pressure if you're not sure. 
Thank you for sharing! 😊
```

### Check Question Table

```sql
SELECT * FROM questions WHERE family_id = '00000000-0000-0000-0000-000000000001';
```

Should see:
- Priority assigned
- Status: `pending` or `asked`
- Warmth-formatted question text

---

## Step 8: Test Coaching

### Ignore a Question

When bot asks a question, don't answer it. Instead:

```
Let me tell you about another time...
```

**Expected:**
1. Question marked as `ignored` after timeout
2. Coach detects high ignore rate
3. If threshold hit, coach adjusts `facilitator_rules.current_signal` to `hold_back`
4. Facilitator reduces question frequency

### Check Event Log

```sql
SELECT * FROM event_log 
WHERE family_id = '00000000-0000-0000-0000-000000000001'
ORDER BY timestamp DESC
LIMIT 10;
```

Should see:
- `question_asked` events
- `question_ignored` events
- `coaching_adjustment` events

---

## Common Issues

### Issue: Bot not receiving messages

**Check:**
1. Bot added to chat group?
2. Bot has appropriate group permissions
3. `.env` has correct `CHAT_PROVIDER_BOT_TOKEN`?

### Issue: Database connection failed

**Check:**
1. Supabase running? `docker ps` should show containers
2. Correct port (54322 for local, not 54321)
3. `.env` has correct `SUPABASE_URL`

### Issue: Claude API errors

**Check:**
1. Valid API key in `.env`?
2. API key has credits? Check https://console.anthropic.com/
3. Network access (not behind firewall blocking anthropic.com)

### Issue: Messages stored but not processed

**Check:**
1. Queue processing running? Check logs
2. Scribe errors? Check `event_log` for `processing_error` events
3. Claude API rate limits hit? Add exponential backoff

---

## Development Workflow

### Running Tests

```bash
# All tests
nx test

# Specific library
nx test agents-scribe
nx test agents-facilitator

# Watch mode
nx test agents-scribe --watch
```

### Linting

```bash
# Lint all
nx lint

# Lint specific app
nx lint conversation-gateway

# Auto-fix
nx lint conversation-gateway --fix
```

### Building

```bash
# Build for production
nx build conversation-gateway --prod

# Output: dist/apps/conversation-gateway/
```

---

## Nx Commands Cheat Sheet

```bash
# Show dependency graph
nx graph

# Show affected projects (after git changes)
nx affected:graph

# Run command on affected projects
nx affected:test

# Clear cache
nx reset

# Show project details
nx show project conversation-gateway
```

---

## Next Steps

**Phase 1 Complete?** → Proceed to Phase 2:
- Implement full Scribe logic
- Add claim creation
- Test entity extraction

**Phase 2 Complete?** → Proceed to Phase 3:
- Implement question generation
- Test warmth formula
- Verify real-time levers

See [IMPLEMENTATION.md](IMPLEMENTATION.md) for full roadmap.

---

## Useful Links

- **Supabase Studio**: http://localhost:54323
- **Supabase Docs**: https://supabase.com/docs
- **Claude API Docs**: https://docs.anthropic.com/
- **Nx Docs**: https://nx.dev/

---

## Getting Help

**Check these first:**
1. [ARCHITECTURE.md](ARCHITECTURE.md) - System design
2. [TECH-STACK.md](TECH-STACK.md) - Technical details
3. [IMPLEMENTATION.md](IMPLEMENTATION.md) - Build plan
4. Event log table - `SELECT * FROM event_log ORDER BY timestamp DESC`

**Still stuck?**
- Check Nx cache: `nx reset`
- Restart Supabase: `supabase stop && supabase start`
- Check Docker: `docker ps` (should show 5+ containers)
- Review logs: `tail -f .nx/workspace-data/*`
