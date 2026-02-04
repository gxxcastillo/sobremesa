# Sobremesa AI Assistant Context

**AI assistant reference documentation for Sobremesa.**

This directory contains AI-specific context and development notes. For human-readable documentation, see `../docs/`.

---

## Start Here

**New to the project?** Read in this order:

1. **[../docs/PRODUCT.md](../docs/PRODUCT.md)** - What Sobremesa is and why it exists
2. **[../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)** - System design and data flow
3. **[../docs/TECH-STACK.md](../docs/TECH-STACK.md)** - Technologies and tools
4. **[../docs/QUICKSTART.md](../docs/QUICKSTART.md)** - Get running locally

---

## Documentation Location

### Human-Readable Documentation (../docs/)

See `../docs/README.md` for complete index.

**Key documents:**

- [../docs/PRODUCT.md](../docs/PRODUCT.md) - Product vision
- [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) - System design
- [../docs/AGENTS.md](../docs/AGENTS.md) - All agent specs (consolidated)
- [../docs/DOMAIN-MODEL.md](../docs/DOMAIN-MODEL.md) - Data contracts
- [../docs/QUICKSTART.md](../docs/QUICKSTART.md) - Setup guide

### AI Assistant Context (this directory)

| Document                             | Purpose                                       |
| ------------------------------------ | --------------------------------------------- |
| [NX.md](NX.md)                       | Nx MCP server instructions for AI assistants  |
| [CONFIGURATION.md](CONFIGURATION.md) | Configuration approach and examples           |
| [ADMIN-UI.md](ADMIN-UI.md)           | Studio admin features (partially implemented) |
| [../docs/adr/](../docs/adr/)         | Architecture Decision Records (ADRs)          |

**Database Schema:** See `apps/db/supabase/migrations/` for the source of truth.

**Configuration Types:** See `libs/shared/types/src/lib/config.ts` and `libs/shared/types/src/lib/conversation.ts` for actual interfaces.

---

## Documentation Map

```
Product Understanding
    ├── PRODUCT.md          <- Start here
    ├── WARMTH.md
    └── CULTURE.md

System Architecture
    ├── ARCHITECTURE.md     <- System design
    ├── DOMAIN-MODEL.md
    ├── DATA-ISOLATION.md
    └── ERROR-HANDLING.md

Data Models
    ├── DATA-MODELS.md      <- Overview of all models
    ├── RELATIONSHIPS.md    <- How people connect
    └── PEOPLE-AND-ROLES.md <- People, identities, roles

Technical Setup
    ├── TECH-STACK.md       <- Technologies
    ├── QUICKSTART.md       <- Get started
    └── NX-MONOREPO-STRUCTURE.md

Agents (AI Components)
    └── AGENTS.md           <- All agent specs (consolidated)

.claude/ (AI Context)
    ├── NX.md               <- Nx MCP instructions
    ├── CONFIGURATION.md    <- Config approach
    └── ADMIN-UI.md         <- Studio admin features
```

---

## Quick Reference for AI Assistants

### Understanding the System

1. [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) - Data flow and components
2. [../docs/AGENTS.md](../docs/AGENTS.md) - Agent overview
3. `apps/db/supabase/migrations/` - Database schema
4. [../docs/DOMAIN-MODEL.md](../docs/DOMAIN-MODEL.md) - Data contracts

### Working with Nx

- [NX.md](NX.md) - MCP server tools and guidelines
- Use `nx_workspace`, `nx_project_details`, `nx_docs` tools

### Key Decisions

- [../docs/adr/](../docs/adr/) - Architecture Decision Records
- [CONFIGURATION.md](CONFIGURATION.md) - Configuration approach

### Making Changes

1. Read relevant specs in `../docs/`
2. Check [../docs/adr/](../docs/adr/) for context
3. For DB changes, add migrations to `apps/db/supabase/migrations/`

---

## Quick Reference Table

| Task                   | Documentation                                      |
| ---------------------- | -------------------------------------------------- |
| Understand product     | [../docs/PRODUCT.md](../docs/PRODUCT.md)           |
| Set up dev environment | [../docs/QUICKSTART.md](../docs/QUICKSTART.md)     |
| Understand data flow   | [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) |
| Database schema        | `apps/db/supabase/migrations/`                     |
| Configuration approach | [CONFIGURATION.md](CONFIGURATION.md)               |
| Nx workspace tools     | [NX.md](NX.md)                                     |
| Past decisions         | [../docs/adr/](../docs/adr/)                       |
| Implement agents       | [../docs/AGENTS.md](../docs/AGENTS.md)             |

---

**For humans:** See [../docs/README.md](../docs/README.md) for complete documentation index.
