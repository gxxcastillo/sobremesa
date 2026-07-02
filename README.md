# Sobremesa

> _"Sobremesa"_ - That special time after a meal when family gathers, conversation flows, and stories are shared.

An AI-powered family history collection system that preserves your family's stories through warm, natural conversation.

## What It Does

- **Stories flow naturally** - No forms, no interviews, just conversation
- **AI asks thoughtful questions** - Filling gaps while respecting emotional boundaries
- **Conflicts are preserved** - Different memories honored, never auto-resolved
- **Multiple languages** - Bilingual storage with cultural context
- **Everything is sourced** - Complete provenance for every fact

## How It Works

A pipeline of specialized agents processes incoming chat messages: routing, extracting claims,
resolving entities, detecting conflicts, and building a structured knowledge graph while maintaining
complete provenance. The same ledger and queue also support super-admin WhatsApp history imports.

## Quick Start

```bash
# Install
bun install

# Set up environment
cp .env.example .env
# Edit .env with your credentials (see docs/QUICKSTART.md)

# Run
bun nx serve chatbots
```

See **[docs/QUICKSTART.md](docs/QUICKSTART.md)** for the full setup guide.

## Documentation

Current system behavior is specified in [`spec/`](spec/). Treat it as canonical when implementation
and older docs disagree.

| Document                                           | Purpose                                   |
| -------------------------------------------------- | ----------------------------------------- |
| [spec/README.md](spec/README.md)                   | Canonical technical specification         |
| [docs/QUICKSTART.md](docs/QUICKSTART.md)           | Local setup and common commands           |
| [spec/product/product.md](spec/product/product.md) | Product vision and principles             |
| [spec/product/warmth.md](spec/product/warmth.md)   | Product voice and warmth guidelines       |
| [spec/product/culture.md](spec/product/culture.md) | Cultural and language adaptation guidance |
| [docs/adr/README.md](docs/adr/README.md)           | Historical architecture decision records  |
| [AGENTS.md](AGENTS.md)                             | Contributor/agent working instructions    |

## Tech Stack

- **Runtime:** Bun + TypeScript
- **Monorepo:** Nx + Bun workspaces
- **Database:** PostgreSQL (Supabase)
- **AI:** Anthropic Claude, OpenAI-compatible local providers, mock provider
- **Chat:** Telegram
- **Web:** Solid.js Studio + Elysia API

## Project Structure

```
apps/
  api/                # Elysia REST API for Studio
  chatbots/           # Telegram bot and live pipeline
  db/                 # Supabase migrations
  studio/             # Solid.js web app

libs/
  agents/             # Intern, Scribe, Registrar, Historian, Facilitator, Admin, Curator
  import/             # WhatsApp import jobs and Intern review
  import-utils/       # WhatsApp parser and import cost estimation
  database/           # Supabase repositories
  prompts/            # System prompts
  queue/              # Message processing
  shared/             # Shared types and utilities

spec/                 # Canonical technical specification (spec/product/ = normative product requirements)
docs/                 # Onboarding guide and historical ADRs
scripts/              # Development and testing scripts (simulate-messages.ts, summary.ts, ...)
```
