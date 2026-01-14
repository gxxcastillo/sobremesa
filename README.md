# Nx TypeScript Repository

<a alt="Nx logo" href="https://nx.dev" target="_blank" rel="noreferrer"><img src="https://raw.githubusercontent.com/nrwl/nx/master/images/nx-logo.png" width="45"></a>

✨ A repository showcasing key [Nx](https://nx.dev) features for TypeScript monorepos ✨

## 📦 Project Overview

This repository demonstrates a production-ready TypeScript monorepo with:

- **3 Publishable Packages** - Ready for NPM publishing

  - `@sobremesa/strings` - String manipulation utilities
  - `@sobremesa/async` - Async utility functions with retry logic
  - `@sobremesa/colors` - Color conversion and manipulation utilities

- **1 Internal Library**
  - `@sobremesa/utils` - Shared utilities (private, not published)

## 🚀 Quick Start

```bash
# Clone the repository
git clone <your-fork-url>
cd typescript-template

# Install dependencies
npm install

# Build all packages
npx nx run-many -t build

# Run tests
npx nx run-many -t test

# Lint all projects
npx nx run-many -t lint

# Run everything in parallel
npx nx run-many -t lint test build --parallel=3

# Visualize the project graph
npx nx graph
```

## ⭐ Featured Nx Capabilities

This repository showcases several powerful Nx features:

### 1. 🔒 Module Boundaries

Enforces architectural constraints using tags. Each package has specific dependencies it can use:

- `scope:shared` (utils) - Can be used by all packages
- `scope:strings` - Can only depend on shared utilities
- `scope:async` - Can only depend on shared utilities
- `scope:colors` - Can only depend on shared utilities

**Try it out:**

```bash
# See the current project graph and boundaries
npx nx graph

# View a specific project's details
npx nx show project strings --web
```

[Learn more about module boundaries →](https://nx.dev/features/enforce-module-boundaries)

### 2. 🛠️ Custom Run Commands

Packages can define custom commands beyond standard build/test/lint:

```bash
# Run the custom build-base command for strings package
npx nx run strings:build-base

# See all available targets for a project
npx nx show project strings
```

[Learn more about custom run commands →](https://nx.dev/concepts/executors-and-configurations)

### 3. 🔧 Self-Healing CI

The CI pipeline includes `nx fix-ci` which automatically identifies and suggests fixes for common issues. To test it, you can make a change to `async-retry.spec.ts` so that it fails, and create a PR.

```bash
# Run tests and see the failure
npx nx test async

# In CI, this command provides automated fixes
npx nx fix-ci
```

[Learn more about self-healing CI →](https://nx.dev/ci/features/self-healing-ci)

### 4. 📦 Package Publishing

Manage releases and publishing with Nx Release:

```bash
# Dry run to see what would be published
npx nx release --dry-run

# Version and release packages
npx nx release

# Publish only specific packages
npx nx release publish --projects=strings,colors
```

[Learn more about Nx Release →](https://nx.dev/features/manage-releases)

## 📁 Project Structure

```
├── packages/
│   ├── strings/     [scope:strings] - String utilities (publishable)
│   ├── async/       [scope:async]   - Async utilities (publishable)
│   ├── colors/      [scope:colors]  - Color utilities (publishable)
│   └── utils/       [scope:shared]  - Shared utilities (private)
├── nx.json          - Nx configuration
├── tsconfig.json    - TypeScript configuration
└── eslint.config.mjs - ESLint with module boundary rules
```

## 🏷️ Understanding Tags

This repository uses tags to enforce module boundaries:

| Package              | Tag             | Can Import From        |
| -------------------- | --------------- | ---------------------- |
| `@sobremesa/utils`   | `scope:shared`  | Nothing (base library) |
| `@sobremesa/strings` | `scope:strings` | `scope:shared`         |
| `@sobremesa/async`   | `scope:async`   | `scope:shared`         |
| `@sobremesa/colors`  | `scope:colors`  | `scope:shared`         |

The ESLint configuration enforces these boundaries, preventing circular dependencies and maintaining clean architecture.

## 🧪 Testing Module Boundaries

To see module boundary enforcement in action:

1. Try importing `@sobremesa/colors` into `@sobremesa/strings`
2. Run `npx nx lint strings`
3. You'll see an error about violating module boundaries

## 📚 Useful Commands

```bash
# Project exploration
npx nx graph                                    # Interactive dependency graph
npx nx list                                     # List installed plugins
npx nx show project strings --web              # View project details

# Development
npx nx build strings                           # Build a specific package
npx nx test async                              # Test a specific package
npx nx lint colors                             # Lint a specific package

# Running multiple tasks
npx nx run-many -t build                       # Build all projects
npx nx run-many -t test --parallel=3          # Test in parallel
npx nx run-many -t lint test build            # Run multiple targets

# Affected commands (great for CI)
npx nx affected -t build                       # Build only affected projects
npx nx affected -t test                        # Test only affected projects

# Release management
npx nx release --dry-run                       # Preview release changes
npx nx release                                 # Create a new release
```

## Nx Cloud

Nx Cloud ensures a [fast and scalable CI](https://nx.dev/ci/intro/why-nx-cloud?utm_source=nx_project&utm_medium=readme&utm_campaign=nx_projects) pipeline. It includes features such as:

- [Remote caching](https://nx.dev/ci/features/remote-cache?utm_source=nx_project&utm_medium=readme&utm_campaign=nx_projects)
- [Task distribution across multiple machines](https://nx.dev/ci/features/distribute-task-execution?utm_source=nx_project&utm_medium=readme&utm_campaign=nx_projects)
- [Automated e2e test splitting](https://nx.dev/ci/features/split-e2e-tasks?utm_source=nx_project&utm_medium=readme&utm_campaign=nx_projects)
- [Task flakiness detection and rerunning](https://nx.dev/ci/features/flaky-tasks?utm_source=nx_project&utm_medium=readme&utm_campaign=nx_projects)

## 🔗 Learn More

- [Nx Documentation](https://nx.dev)
- [Module Boundaries](https://nx.dev/features/enforce-module-boundaries)
- [Custom Commands](https://nx.dev/concepts/executors-and-configurations)
- [Self-Healing CI](https://nx.dev/ci/features/self-healing-ci)
- [Releasing Packages](https://nx.dev/features/manage-releases)
- [Nx Cloud](https://nx.dev/ci/intro/why-nx-cloud)

## 💬 Community

Join the Nx community:

- [Discord](https://go.nx.dev/community)
- [X (Twitter)](https://twitter.com/nxdevtools)
- [LinkedIn](https://www.linkedin.com/company/nrwl)
- [YouTube](https://www.youtube.com/@nxdevtools)
- [Blog](https://nx.dev/blog)

-------- NEW ------

# Sobremesa

> _"Sobremesa"_ - That special time after a meal when family gathers, conversation flows, and stories are shared.

An AI-powered family history collection system that preserves your family's stories through warm, natural conversation.

---

## What is Sobremesa?

Sobremesa helps families preserve their history by creating a warm, conversational space where:

- **Stories flow naturally** - No forms, no interviews, just conversation
- **AI asks thoughtful questions** - Filling in gaps while respecting emotional boundaries
- **Conflicts are preserved** - Different memories honored, never auto-resolved
- **Multiple languages supported** - Bilingual storage with cultural term preservation
- **Everything is sourced** - Complete provenance for every fact

Perfect for families who want to preserve their heritage before precious memories are lost.

---

## Quick Start

### Prerequisites

- Node.js 18+
- npm or yarn
- Supabase account (free tier works)
- Chat Provider account
- Anthropic API key

### 1. Clone and Install

```bash
# Clone the repository
git clone <your-repo-url> sobremesa-workspace
cd sobremesa-workspace

# Install dependencies
npm install
```

### 2. Set Up Environment

```bash
# Copy environment template
cp .env.example .env

# Edit .env with your credentials:
# - CHAT PROVIDER_BOT_TOKEN (from @BotFather)
# - ANTHROPIC_API_KEY (from Anthropic Console)
# - SUPABASE_URL and SUPABASE_ANON_KEY (from Supabase)
```

### 3. Set Up Database

```bash
# Run the schema on your Supabase instance
# Copy .claude/SCHEMA.sql and run it in Supabase SQL Editor
```

### 4. Build and Run

```bash
# Build all libraries
nx run-many -t build

# Run the Chat Provider bot
nx run chat provider-bot:serve
```

### 5. Add Bot to Chat Provider Group

1. Create a Chat Provider group for your family
2. Add your bot (search for your bot name)
3. Start sharing stories!

---

## Project Structure

```
sobremesa-workspace/
├── .claude/                   # Complete system documentation
│   ├── ARCHITECTURE.md       # System design and data flow
│   ├── AGENTS.md             # AI agent specifications
│   ├── CONFIGURATION.md      # How to configure for your family
│   ├── WARMTH.md             # Core philosophy (read this!)
│   ├── IMPLEMENTATION.md     # Build plan
│   └── SCHEMA.sql            # Database schema
│
├── prompts/                   # AI system prompts
│   ├── facilitator.md       # Question-asking agent
│   ├── admin.md             # Project management agent
│   ├── scribe.md        # Data extraction agent
│   └── curator.md  # Image analysis agent
│
├── apps/
│   └── chat provider-bot/         # Main bot application
│
└── libs/
    ├── agents/               # AI agents (facilitator, admin, scribe)
    ├── database/             # Supabase integration
    ├── queue/                # Message processing queue
    └── ...                   # Other libraries
```

---

## Documentation

### Essential Reading

Start here to understand the system:

1. **[WARMTH.md](.claude/WARMTH.md)** - Why warmth is core to the product
2. **[ARCHITECTURE.md](.claude/ARCHITECTURE.md)** - System design and data flow
3. **[AGENTS.md](.claude/AGENTS.md)** - How the 5 AI agents work
4. **[CONFIGURATION.md](.claude/CONFIGURATION.md)** - Customize for your family

### Additional Docs

- **[IMPLEMENTATION.md](.claude/IMPLEMENTATION.md)** - 6-week build plan with demo flow
- **[DECISIONS.md](.claude/DECISIONS.md)** - Architecture decision records (why we built it this way)
- **[CULTURE.md](.claude/CULTURE.md)** - Adapting for different cultures and languages
- **[NX-MONOREPO-STRUCTURE.md](.claude/NX-MONOREPO-STRUCTURE.md)** - Nx workspace layout

---

## How It Works

### The Agents

**Sobremesa uses 5 AI agents working together:**

1. **👥 Carmencita (Facilitator)** - Asks warm questions to fill gaps
2. **🔧 La Directora (Admin)** - Celebrates milestones, mediates conflicts
3. **📝 Don Rubén (Scribe)** - Extracts data, generates questions
4. **🎨 Curator** - Analyzes photos and documents (hidden)
5. **💾 Registrar** - Saves everything with provenance (backend)

_Note: Names are configurable - "Carmencita" is the default for a Nicaraguan family._

### The Flow

```
1. Family shares story in Chat Provider
   ↓
2. Scribe extracts people, places, events, creates claims
   ↓
3. Registrar saves to database with full provenance
   ↓
4. Facilitator asks warm follow-up questions
   ↓
5. Coaching module optimizes based on family response
```

### Key Features

- **✨ Warmth-first** - Every interaction uses the [Warmth] + [Question] + [Permission] + [Gratitude] formula
- **📊 Claims-based** - Every fact has a source, confidence level, and provenance
- **🔄 Conflict preservation** - Different memories honored, never auto-resolved
- **🌍 Bilingual+** - Original language + translations, cultural terms preserved
- **🎯 Adaptive** - System learns and optimizes engagement based on family patterns
- **🔒 Privacy** - Redaction support, GDPR compliant
- **⛓️ Web3 ready** - Optional Solana integration for tamper-proof audit trail

---

## Configuration

### Default: Nicaraguan Family

The system ships with default settings for a Spanish/English bilingual family:

```typescript
{
  projectName: "Sobremesa",
  languages: { primary: "es", secondary: ["en"] },
  bots: {
    facilitator: { displayName: "Carmencita" },
    admin: { displayName: "La Directora" },
    scribe: { displayName: "Don Rubén" }
  },
  culturalTerms: ["pulpería", "gallo pinto", "vigorón"]
}
```

### Customize for Your Family

See [CONFIGURATION.md](.claude/CONFIGURATION.md) for complete customization guide:

- Different languages (English, Japanese, Italian, etc.)
- Different bot names and personalities
- Cultural term preservation
- Formality and emoji usage

---

## Development

### Nx Commands

```bash
# Build everything
nx run-many -t build

# Run tests
nx run-many -t test

# Lint
nx run-many -t lint

# Build specific library
nx build agents-facilitator

# View dependency graph
nx graph

# Generate new library
nx g @nx/node:library my-library --directory=libs
```

### Development Workflow

1. Make changes in `libs/`
2. Run tests: `nx test <library-name>`
3. Build: `nx build chat provider-bot`
4. Test in Chat Provider group
5. Check event log in database for debugging

---

## Database

### Schema

Complete PostgreSQL schema in `.claude/SCHEMA.sql`:

- 16 tables (messages, people, places, events, stories, claims, etc.)
- 4 helper views
- Complete audit trail (event_log)
- Bilingual storage (original + translations)
- Web3 integration ready

### Key Tables

- **messages** - Raw Chat Provider messages
- **claims** - All factual claims with provenance _(key innovation)_
- **people, places, events, stories** - Extracted entities
- **questions** - Facilitator's question queue
- **facilitator_rules** - Dynamic engagement rules
- **real_time_levers** - Immediate conversation flow controls
- **event_log** - Complete audit trail

---

## Deployment

### Production Checklist

- [ ] Set up Supabase production database
- [ ] Run SCHEMA.sql on production database
- [ ] Configure environment variables
- [ ] Set up Chat Provider bot (production token)
- [ ] Deploy bot application (Railway, Render, AWS, etc.)
- [ ] Configure real-time levers for your family
- [ ] Test warmth formula in production
- [ ] Monitor event_log for issues

### Environment Variables (Production)

```bash
NODE_ENV=production
LOG_LEVEL=info
CHAT PROVIDER_BOT_TOKEN=<production-token>
ANTHROPIC_API_KEY=<production-key>
SUPABASE_URL=<production-url>
SUPABASE_ANON_KEY=<production-key>
```

---

## Contributing

This is a reusable library designed to work for any family. Contributions welcome!

### Areas for Contribution

- New language support (Chinese, Arabic, etc.)
- Cultural adaptation guides
- Additional prompt templates
- Dashboard UI
- Knowledge graph visualization
- Additional scribe extractors

### Development Guidelines

1. Read `.claude/WARMTH.md` first - warmth is non-negotiable
2. Follow architecture in `.claude/ARCHITECTURE.md`
3. Use generic role names in code (`BotRole.FACILITATOR`)
4. Make everything configurable
5. Preserve conflicts, never auto-resolve
6. Test with multiple languages
7. Document cultural considerations

---

## Architecture Principles

1. **Warmth First** - Not optional, IS the product
2. **Configurable** - Works for any family, any culture, any language
3. **Claims-Based** - Provenance for everything
4. **Conflict Preservation** - Never auto-resolve disagreements
5. **Single Writer** - Only Registrar modifies core tables
6. **Adaptive** - System learns and optimizes
7. **Auditable** - Complete event log
8. **Privacy-Respecting** - Redaction and GDPR compliance

See [DECISIONS.md](.claude/DECISIONS.md) for full architecture decision records.

---

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **Bot Framework**: Telegraf (Chat Provider Bot API)
- **Database**: PostgreSQL (Supabase)
- **AI**: Anthropic Claude API (Sonnet)
- **Queue**: In-memory (POC) → Redis (production)
- **Monorepo**: Nx
- **Web3** (optional): Solana

---

## Support

### Common Issues

See [.claude/TROUBLESHOOTING.md](.claude/TROUBLESHOOTING.md) (if exists) or check:

**Bot not responding?**

- Check event_log table for errors
- Verify CHAT PROVIDER_BOT_TOKEN
- Check Anthropic API quota

**Questions too frequent?**

- Coaching module will auto-adjust
- Check facilitator_rules table
- Adjust real_time_levers if needed

**Wrong language?**

- Check config.languages.primary
- Verify message language detection
- Check cultural terms preservation

---

## License

[Your License Here - e.g., MIT]

---

## Acknowledgments

Built with warmth for families everywhere who want to preserve their stories before they're lost.

**Special thanks to:**

- Families sharing their precious memories
- The Ruby Darío literary tradition (inspiration for "Don Rubén")
- The concept of "sobremesa" - that beautiful after-meal conversation time

---

## Contact

[Your contact information]

---

**Remember:** Warmth = Data Quality. Without warmth, people clam up. With warmth, stories flow. 💝
