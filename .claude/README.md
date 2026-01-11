# Sobremesa Documentation Index

**Complete system documentation for building Sobremesa.**

This directory contains all specifications, decisions, and guides needed to build Sobremesa - a conversation-first family memory platform.

---

## 📖 Start Here

**New to the project?** Read in this order:

1. **[PRODUCT.md](PRODUCT.md)** - What Sobremesa is and why it exists
2. **[ARCHITECTURE.md](ARCHITECTURE.md)** - System design and data flow
3. **[TECH-STACK.md](TECH-STACK.md)** - Technologies and tools
4. **[QUICKSTART.md](QUICKSTART.md)** - Get running locally in 30 min

---

## 📚 Core Documentation

### Product & Design

| Document | Purpose |
|----------|---------|
| [PRODUCT.md](PRODUCT.md) | Product vision, principles, and non-negotiables |
| [WARMTH.md](WARMTH.md) | The warmth formula and why it matters |
| [CULTURE.md](CULTURE.md) | Cultural adaptation and language considerations |

### Architecture & Technical

| Document | Purpose |
|----------|---------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System architecture, data flow, and key decisions |
| [TECH-STACK.md](TECH-STACK.md) | Complete technology stack and setup |
| [DOMAIN-MODEL.md](DOMAIN-MODEL.md) | Contract between Scribe/Curator → Registrar |
| [DATA-ISOLATION.md](DATA-ISOLATION.md) | Multi-family data isolation strategy |
| [ERROR-HANDLING.md](ERROR-HANDLING.md) | Failure scenarios and resilience patterns |

### Agents

| Document | Purpose |
|----------|---------|
| [AGENTS.md](AGENTS.md) | Overview of all 5 agents |
| [AGENT_FACILITATOR.md](AGENT_FACILITATOR.md) | Facilitator agent specification |
| [AGENT_ADMIN.md](AGENT_ADMIN.md) | Admin agent specification |
| [AGENT_SCRIBE.md](AGENT_SCRIBE.md) | Scribe agent specification |
| [AGENT_CURATOR.md](AGENT_CURATOR.md) | Curator agent specification |
| [AGENT_REGISTRAR.md](AGENT_REGISTRAR.md) | Registrar specification (data writer) |

### Configuration & Setup

| Document | Purpose |
|----------|---------|
| [CONFIGURATION.md](CONFIGURATION.md) | Complete configuration guide |
| [NX-MONOREPO-STRUCTURE.md](NX-MONOREPO-STRUCTURE.md) | Nx workspace structure |
| [NX.md](NX.md) | Nx-specific notes and commands |
| [SCHEMA.sql](SCHEMA.sql) | PostgreSQL database schema |

### Implementation

| Document | Purpose |
|----------|---------|
| [IMPLEMENTATION.md](IMPLEMENTATION.md) | 6-phase implementation plan |
| [DECISIONS.md](DECISIONS.md) | Architecture Decision Records (ADRs) |
| [QUICKSTART.md](QUICKSTART.md) | Local development setup guide |

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
    ├── AGENT_CURATOR.md
    └── AGENT_REGISTRAR.md

Implementation
    ├── IMPLEMENTATION.md   ← Build roadmap
    └── DECISIONS.md        ← Why we made choices
```

---

## 🎯 By Role

### I'm a Developer

**First time?**
1. [PRODUCT.md](PRODUCT.md) - Understand the vision
2. [ARCHITECTURE.md](ARCHITECTURE.md) - Learn the system
3. [QUICKSTART.md](QUICKSTART.md) - Get it running
4. [IMPLEMENTATION.md](IMPLEMENTATION.md) - Start building

**Building a specific component?**
- **Scribe?** → [AGENT_SCRIBE.md](AGENT_SCRIBE.md), [DOMAIN-MODEL.md](DOMAIN-MODEL.md)
- **Facilitator?** → [AGENT_FACILITATOR.md](AGENT_FACILITATOR.md), [WARMTH.md](WARMTH.md)
- **Admin?** → [AGENT_ADMIN.md](AGENT_ADMIN.md)
- **Database?** → [SCHEMA.sql](SCHEMA.sql), [DATA-ISOLATION.md](DATA-ISOLATION.md)
- **Configuration?** → [CONFIGURATION.md](CONFIGURATION.md)

### I'm a Product Manager

**Understanding the product:**
1. [PRODUCT.md](PRODUCT.md) - Core product definition
2. [WARMTH.md](WARMTH.md) - Why warmth is critical
3. [CULTURE.md](CULTURE.md) - Cultural considerations
4. [AGENTS.md](AGENTS.md) - How the system works

**Making decisions:**
- [DECISIONS.md](DECISIONS.md) - Past architectural decisions
- [CONFIGURATION.md](CONFIGURATION.md) - What's configurable

### I'm a Data Scientist / AI Engineer

**Understanding the AI:**
1. [AGENTS.md](AGENTS.md) - Agent overview
2. [AGENT_SCRIBE.md](AGENT_SCRIBE.md) - Data extraction
3. [AGENT_FACILITATOR.md](AGENT_FACILITATOR.md) - Decision logic
4. [DOMAIN-MODEL.md](DOMAIN-MODEL.md) - Data structures
5. [WARMTH.md](WARMTH.md) - Prompt engineering

**Improving agents:**
- Scribe accuracy → [AGENT_SCRIBE.md](AGENT_SCRIBE.md)
- Question quality → [AGENT_FACILITATOR.md](AGENT_FACILITATOR.md)
- Coaching system → [AGENT_ADMIN.md](AGENT_ADMIN.md)

### I'm a DevOps Engineer

**Deploying the system:**
1. [TECH-STACK.md](TECH-STACK.md) - Infrastructure requirements
2. [ERROR-HANDLING.md](ERROR-HANDLING.md) - Failure scenarios
3. [DATA-ISOLATION.md](DATA-ISOLATION.md) - Multi-tenancy
4. [SCHEMA.sql](SCHEMA.sql) - Database setup

**Monitoring:**
- [ERROR-HANDLING.md](ERROR-HANDLING.md) - Metrics and health checks

---

## 📋 By Task

### Setting Up Development

1. [TECH-STACK.md](TECH-STACK.md) - Install prerequisites
2. [QUICKSTART.md](QUICKSTART.md) - Step-by-step setup
3. [NX-MONOREPO-STRUCTURE.md](NX-MONOREPO-STRUCTURE.md) - Understand structure

### Understanding the System

1. [ARCHITECTURE.md](ARCHITECTURE.md) - Data flow
2. [AGENTS.md](AGENTS.md) - Components
3. [DOMAIN-MODEL.md](DOMAIN-MODEL.md) - Data contracts

### Implementing Features

1. [IMPLEMENTATION.md](IMPLEMENTATION.md) - Roadmap
2. Relevant agent spec (e.g., [AGENT_SCRIBE.md](AGENT_SCRIBE.md))
3. [DOMAIN-MODEL.md](DOMAIN-MODEL.md) - Data structures

### Configuring for a Family

1. [CONFIGURATION.md](CONFIGURATION.md) - Full config guide
2. [CULTURE.md](CULTURE.md) - Cultural adaptation
3. [WARMTH.md](WARMTH.md) - Personality tuning

### Debugging Issues

1. [ERROR-HANDLING.md](ERROR-HANDLING.md) - Common failures
2. [SCHEMA.sql](SCHEMA.sql) - Database structure
3. Check `event_log` table for errors

### Deploying to Production

1. [TECH-STACK.md](TECH-STACK.md) - Infrastructure
2. [DATA-ISOLATION.md](DATA-ISOLATION.md) - Security
3. [ERROR-HANDLING.md](ERROR-HANDLING.md) - Monitoring

---

## 🔑 Key Concepts

### Product Principles

**Warmth over efficiency** - Be conversational, not interrogative  
→ See [WARMTH.md](WARMTH.md)

**Preservation over resolution** - Keep all versions of truth  
→ See [ARCHITECTURE.md](ARCHITECTURE.md#claims-based-data-model)

**Multi-family from day one** - Complete data isolation  
→ See [DATA-ISOLATION.md](DATA-ISOLATION.md)

### Technical Patterns

**Claims-based data model** - Every fact has provenance  
→ See [ARCHITECTURE.md](ARCHITECTURE.md#claims-based-data-model)

**Single writer pattern** - Only Registrar modifies DB  
→ See [ARCHITECTURE.md](ARCHITECTURE.md#single-writer-pattern)

**Domain model contract** - Scribe/Curator → Registrar  
→ See [DOMAIN-MODEL.md](DOMAIN-MODEL.md)

**Two-tier coaching** - Static config + dynamic rules + real-time levers  
→ See [ARCHITECTURE.md](ARCHITECTURE.md#coaching-module-with-real-time-levers)

---

## 🚀 Getting Started Paths

### Path 1: Quick Demo (1 hour)

1. Read [PRODUCT.md](PRODUCT.md) (10 min)
2. Skim [ARCHITECTURE.md](ARCHITECTURE.md) (15 min)
3. Follow [QUICKSTART.md](QUICKSTART.md) (30 min)
4. Send test messages (5 min)

### Path 2: Deep Understanding (4 hours)

1. Read [PRODUCT.md](PRODUCT.md) (20 min)
2. Read [ARCHITECTURE.md](ARCHITECTURE.md) (45 min)
3. Read [AGENTS.md](AGENTS.md) (30 min)
4. Read [DOMAIN-MODEL.md](DOMAIN-MODEL.md) (30 min)
5. Read [WARMTH.md](WARMTH.md) (20 min)
6. Skim [CONFIGURATION.md](CONFIGURATION.md) (30 min)
7. Follow [QUICKSTART.md](QUICKSTART.md) (45 min)

### Path 3: Full Mastery (8 hours)

1. All documents in "Core Documentation" (6 hours)
2. All agent specifications (1 hour)
3. Set up local environment (1 hour)

---

## 📝 Document Standards

### Format

- **Markdown** (.md) for all documentation
- **Code blocks** with language identifiers
- **Tables** for comparisons
- **Mermaid diagrams** for flows (where helpful)

### Structure

Each document should have:
- Clear title and purpose
- Table of contents (if long)
- Examples (especially for technical docs)
- "Next Steps" or related documents

### Maintenance

- Update [DECISIONS.md](DECISIONS.md) when making architectural changes
- Update agent specs when changing behavior
- Keep [IMPLEMENTATION.md](IMPLEMENTATION.md) in sync with progress

---

## 🤝 Contributing

When adding new documentation:

1. **Follow the pattern** - Use existing docs as templates
2. **Add to this index** - Update the tables above
3. **Cross-reference** - Link to related documents
4. **Be specific** - Include code examples, not just concepts
5. **Explain why** - Not just what, but why we chose it

---

## 📞 Quick Reference

| Need to... | See... |
|------------|--------|
| Understand product vision | [PRODUCT.md](PRODUCT.md) |
| Set up dev environment | [QUICKSTART.md](QUICKSTART.md) |
| Understand data flow | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Configure for a family | [CONFIGURATION.md](CONFIGURATION.md) |
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
