# Sobremesa

> _"Sobremesa"_ - That special time after a meal when family gathers, conversation flows, and stories are shared.

An AI-powered family history collection system that preserves your family's stories through warm, natural conversation.

## What It Does

- **Stories flow naturally** - No forms, no interviews, just conversation
- **AI asks thoughtful questions** - Filling gaps while respecting emotional boundaries
- **Conflicts are preserved** - Different memories honored, never auto-resolved
- **Multiple languages** - Bilingual storage with cultural context
- **Everything is sourced** - Complete provenance for every fact

## Quick Start

```bash
# Install
pnpm install

# Set up environment
cp .env.example .env
# Edit .env with your credentials (see docs/QUICKSTART.md)

# Run
nx serve chatbots
```

See **[docs/QUICKSTART.md](docs/QUICKSTART.md)** for full setup guide.

## Documentation

All documentation lives in [`docs/`](docs/):

| Document                                | Purpose                       |
| --------------------------------------- | ----------------------------- |
| [QUICKSTART.md](docs/QUICKSTART.md)     | Get running locally           |
| [PRODUCT.md](docs/PRODUCT.md)           | Product vision and principles |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design and data flow   |
| [AGENTS.md](docs/AGENTS.md)             | AI agent specifications       |
| [WARMTH.md](docs/WARMTH.md)             | Core philosophy               |

## Tech Stack

- **Runtime:** Node.js + TypeScript
- **Monorepo:** Nx
- **Database:** PostgreSQL (Supabase)
- **AI:** Anthropic Claude API
- **Chat:** Telegram (pluggable)

## Project Structure

```
apps/
  chatbots/           # Main application
  db/                 # Database migrations

libs/
  agents/             # AI agents (facilitator, scribe, historian, etc.)
  database/           # Supabase repositories
  prompts/            # System prompts
  queue/              # Message processing
  shared/             # Shared types and utilities

docs/                 # All documentation
```
