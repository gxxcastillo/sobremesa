# Sobremesa AI Assistant Context

**AI assistant reference documentation for Sobremesa.**

This directory contains AI-specific context and development notes. For human-readable documentation, see `../docs/`.

---

## 📖 Start Here (For AI Assistants)

**New to the project?** Read in this order:

1. **[../docs/PRODUCT.md](../docs/PRODUCT.md)** - What Sobremesa is and why it exists
2. **[../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)** - System design and data flow
3. **[../docs/TECH-STACK.md](../docs/TECH-STACK.md)** - Technologies and tools
4. **[../docs/QUICKSTART.md](../docs/QUICKSTART.md)** - Get running locally in 30 min

---

## 📚 Documentation Location

### Human-Readable Documentation (../docs/)

See `../docs/README.md` for complete index.

**Key documents:**

- [../docs/PRODUCT.md](../docs/PRODUCT.md) - Product vision
- [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) - System design
- [../docs/AGENTS.md](../docs/AGENTS.md) - Agent overview
- [../docs/AGENT\_\*.md](../docs/) - Individual agent specs
- [../docs/QUICKSTART.md](../docs/QUICKSTART.md) - Setup guide
- [../docs/IMPLEMENTATION.md](../docs/IMPLEMENTATION.md) - Build roadmap

### AI Assistant Context (this directory)

| Document                               | Purpose                                       |
| -------------------------------------- | --------------------------------------------- |
| [NX.md](NX.md)                         | Nx MCP server instructions for AI assistants  |
| [CONFIGURATION.md](CONFIGURATION.md)   | Configuration notes                           |
| [DECISIONS.md](DECISIONS.md)           | Architecture Decision Records (ADRs)          |
| [SCHEMA.sql](SCHEMA.sql)               | PostgreSQL database schema (for AI reference) |
| [SCHEMA-UPDATES.md](SCHEMA-UPDATES.md) | Migration notes                               |
| settings.local.json                    | AI assistant settings                         |

---

## 🗺️ Documentation Map

```
Product Understanding
    ├── PRODUCT.md          ← Start here
    ├── WARMTH.md
    └── CULTURE.md

System Architecture
    ├── ARCHITECTURE.md     ← System design
    ├── DOMAIN-MODEL.md
    ├── DATA-ISOLATION.md
    └── ERROR-HANDLING.md

Technical Setup
    ├── TECH-STACK.md       ← Technologies
    ├── QUICKSTART.md       ← Get started
    ├── CONFIGURATION.md
    ├── NX-MONOREPO-STRUCTURE.md
    └── SCHEMA.sql

Agents (AI Components)
    ├── AGENTS.md           ← Overview
    ├── AGENT_FACILITATOR.md
    ├── AGENT_ADMIN.md
    ├── AGENT_SCRIBE.md
.claude/ (AI Context)
    ├── NX.md                    ← Nx MCP instructions
    ├── SCHEMA.sql               ← DB schema reference
    ├── CONFIGURATION.md         ← Config notes
    ├── DECISIONS.md             ← ADRs
    └── SCHEMA-UPDATES.md        ← Migration notes

../docs/ (Human Documentation)
    ├── README.md                ← Documentation index
    ├── QUICKSTART.md            ← Setup guide
    ├─Quick Reference for AI Assistants

### Understanding the System

1. [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) - Data flow and components
2. [../docs/AGENTS.md](../docs/AGENTS.md) - Agent overview
3. [SCHEMA.sql](SCHEMA.sql) - Database schema
4. [../docs/DOMAIN-MODEL.md](../docs/DOMAIN-MODEL.md) - Data contracts

### Working with Nx

- [NX.md](NX.md) - MCP server tools and guidelines
- Use `nx_workspace`, `nx_project_details`, `nx_docs` tools

### Key Decisions

- [DECISIONS.md](DECISIONS.md) - Architecture Decision Records
- [CONFIGURATION.md](CONFIGURATION.md) - Configuration approach

### Making Changes

1. Read relevant specs in `../docs/`
2. Check [DECISIONS.md](DECISIONS.md) for context
3. Update [SCHEMA-UPDATES.md](SCHEMA-UPDATES.md) for DB changes
4. Update `../docs/IMPLEMENTATION.md` for progress trackingTION.md) |
| Implement Scribe | [AGENT_SCRIBE.md](AGENT_SCRIBE.md) + [DOMAIN-MODEL.md](DOMAIN-MODEL.md) |
| Write warm questions | [WARMTH.md](WARMTH.md) |
| Adapt for culture | [CULTURE.md](CULTURE.md) |
| Handle errors | [ERROR-HANDLING.md](ERROR-HANDLING.md) |
| Ensure data isolation | [DATA-ISOLATION.md](DATA-ISOLATION.md) |
| Understand decisions | [DECISIONS.md](DECISIONS.md) |

---

## 🔄 Documentation Versions

Current version: **1.0** (January 2026)

This documentation set was created for the initial implementation. As the system evolves, maintain this index and update individual documents accordingly.

---

**Ready to build?** → Start with [QUICKSTART.md](QUICKSTART.md)
../docs/PRODUCT.md](../docs/PRODUCT.md) |
| Set up dev environment | [../docs/QUICKSTART.md](../docs/QUICKSTART.md) |
| Understand data flow | [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) |
| Database schema | [SCHEMA.sql](SCHEMA.sql) |
| Configuration approach | [CONFIGURATION.md](CONFIGURATION.md) |
| Nx workspace tools | [NX.md](NX.md) |
| Past decisions | [DECISIONS.md](DECISIONS.md) |
| Migration notes | [SCHEMA-UPDATES.md](SCHEMA-UPDATES.md) |

---

**For humans:** See [../docs/README.md](../docs/README.md) for complete documentation index.
```
