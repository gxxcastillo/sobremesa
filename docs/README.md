# Sobremesa Documentation

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
| [QUICKSTART.md](QUICKSTART.md) | Local development setup guide (start here!) |
| [NX-MONOREPO-STRUCTURE.md](NX-MONOREPO-STRUCTURE.md) | Nx workspace structure |

### Implementation

| Document | Purpose |
|----------|---------|
| [IMPLEMENTATION.md](IMPLEMENTATION.md) | 6-phase implementation plan |

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
    └── NX-MONOREPO-STRUCTURE.md

Agents (AI Components)
    ├── AGENTS.md           ← Overview
    ├── AGENT_FACILITATOR.md
    ├── AGENT_ADMIN.md
    ├── AGENT_SCRIBE.md
    ├── AGENT_CURATOR.md
    └── AGENT_REGISTRAR.md

Implementation
    └── IMPLEMENTATION.md   ← Build roadmap
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
- **Database?** → See `apps/db/supabase/migrations/`, [DATA-ISOLATION.md](DATA-ISOLATION.md)

### I'm a Product Manager

**Understanding the product:**
1. [PRODUCT.md](PRODUCT.md) - Core product definition
2. [WARMTH.md](WARMTH.md) - Why warmth is critical
3. [CULTURE.md](CULTURE.md) - Cultural considerations
4. [AGENTS.md](AGENTS.md) - How the system works

### I'm a Data Scientist / AI Engineer

**Understanding the AI:**
1. [AGENTS.md](AGENTS.md) - Agent overview
2. [AGENT_SCRIBE.md](AGENT_SCRIBE.md) - Data extraction
3. [AGENT_FACILITATOR.md](AGENT_FACILITATOR.md) - Decision logic
4. [DOMAIN-MODEL.md](DOMAIN-MODEL.md) - Data structures
5. [WARMTH.md](WARMTH.md) - Prompt engineering

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
6. Follow [QUICKSTART.md](QUICKSTART.md) (45 min)

---

## 📝 Quick Reference

| Need to... | See... |
|------------|--------|
| Understand product vision | [PRODUCT.md](PRODUCT.md) |
| Set up dev environment | [QUICKSTART.md](QUICKSTART.md) |
| Understand data flow | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Implement Scribe | [AGENT_SCRIBE.md](AGENT_SCRIBE.md) + [DOMAIN-MODEL.md](DOMAIN-MODEL.md) |
| Write warm questions | [WARMTH.md](WARMTH.md) |
| Adapt for culture | [CULTURE.md](CULTURE.md) |
| Handle errors | [ERROR-HANDLING.md](ERROR-HANDLING.md) |
| Ensure data isolation | [DATA-ISOLATION.md](DATA-ISOLATION.md) |

---

**Ready to build?** → Start with [QUICKSTART.md](QUICKSTART.md)
