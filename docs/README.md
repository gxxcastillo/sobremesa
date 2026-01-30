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

| Document                 | Purpose                                         |
| ------------------------ | ----------------------------------------------- |
| [PRODUCT.md](PRODUCT.md) | Product vision, principles, and non-negotiables |
| [WARMTH.md](WARMTH.md)   | The warmth formula and why it matters           |
| [CULTURE.md](CULTURE.md) | Cultural adaptation and language considerations |

### Architecture Decisions

See [adr/](adr/) for Architecture Decision Records (ADRs 001-028) documenting key architectural choices.

### Architecture & Technical

| Document                               | Purpose                                             |
| -------------------------------------- | --------------------------------------------------- |
| [ARCHITECTURE.md](ARCHITECTURE.md)     | System architecture, data flow, and key decisions   |
| [TECH-STACK.md](TECH-STACK.md)         | Complete technology stack and setup                 |
| [DOMAIN-MODEL.md](DOMAIN-MODEL.md)     | Contract between Scribe/Curator → Registrar         |
| [DATA-ISOLATION.md](DATA-ISOLATION.md) | Multi-family data isolation strategy                |
| [ERROR-HANDLING.md](ERROR-HANDLING.md) | Failure scenarios and resilience patterns           |
| [SERVICES.md](SERVICES.md)             | Service layer architecture and integration patterns |
| [AUTH.md](AUTH.md)                     | Authentication and authorization system             |

### Agents

| Document               | Purpose                                     |
| ---------------------- | ------------------------------------------- |
| [AGENTS.md](AGENTS.md) | All 7 agents: specs, flows, database access |

Prompts are in `libs/prompts/src/agents/*.txt`

### Data Models

| Document                                   | Purpose                                               |
| ------------------------------------------ | ----------------------------------------------------- |
| [DATA-MODELS.md](DATA-MODELS.md)           | Overview of all data models and relationships         |
| [RELATIONSHIPS.md](RELATIONSHIPS.md)       | Structural/extended relationships, normalization, API |
| [PEOPLE-AND-ROLES.md](PEOPLE-AND-ROLES.md) | People, identities, users, roles, and participants    |

### Configuration & Setup

| Document                                             | Purpose                                     |
| ---------------------------------------------------- | ------------------------------------------- |
| [QUICKSTART.md](QUICKSTART.md)                       | Local development setup guide (start here!) |
| [NX-MONOREPO-STRUCTURE.md](NX-MONOREPO-STRUCTURE.md) | Nx workspace structure                      |

### Implementation

| Document                               | Purpose                     |
| -------------------------------------- | --------------------------- |
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

Data Models
    ├── DATA-MODELS.md      ← Overview of all models
    ├── RELATIONSHIPS.md    ← How people connect
    └── PEOPLE-AND-ROLES.md ← People, identities, roles

Technical Setup
    ├── TECH-STACK.md       ← Technologies
    ├── QUICKSTART.md       ← Get started
    └── NX-MONOREPO-STRUCTURE.md

Agents (AI Components)
    └── AGENTS.md           ← All agent specs (consolidated)

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

- **Any Agent?** → [AGENTS.md](AGENTS.md) (all specs consolidated)
- **Scribe?** → [AGENTS.md](AGENTS.md#scribe-default-don-rubén), [DOMAIN-MODEL.md](DOMAIN-MODEL.md)
- **Facilitator?** → [AGENTS.md](AGENTS.md#facilitator-default-carmencita), [WARMTH.md](WARMTH.md)
- **Database?** → See `apps/db/supabase/migrations/`, [DATA-ISOLATION.md](DATA-ISOLATION.md)

### I'm a Product Manager

**Understanding the product:**

1. [PRODUCT.md](PRODUCT.md) - Core product definition
2. [WARMTH.md](WARMTH.md) - Why warmth is critical
3. [CULTURE.md](CULTURE.md) - Cultural considerations
4. [AGENTS.md](AGENTS.md) - How the system works

### I'm a Data Scientist / AI Engineer

**Understanding the AI:**

1. [AGENTS.md](AGENTS.md) - All agent specs (extraction, decision logic, flows)
2. [DOMAIN-MODEL.md](DOMAIN-MODEL.md) - Data structures
3. [WARMTH.md](WARMTH.md) - Prompt engineering
4. Prompts: `libs/prompts/src/agents/*.txt`

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

| Need to...                    | See...                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| Understand product vision     | [PRODUCT.md](PRODUCT.md)                                                             |
| Set up dev environment        | [QUICKSTART.md](QUICKSTART.md)                                                       |
| Understand data flow          | [ARCHITECTURE.md](ARCHITECTURE.md)                                                   |
| Understand all data models    | [DATA-MODELS.md](DATA-MODELS.md)                                                     |
| Build relationships feature   | [RELATIONSHIPS.md](RELATIONSHIPS.md)                                                 |
| Understand people/roles/users | [PEOPLE-AND-ROLES.md](PEOPLE-AND-ROLES.md)                                           |
| Implement Scribe              | [AGENTS.md](AGENTS.md#scribe-default-don-rubén) + [DOMAIN-MODEL.md](DOMAIN-MODEL.md) |
| Write warm questions          | [WARMTH.md](WARMTH.md)                                                               |
| Adapt for culture             | [CULTURE.md](CULTURE.md)                                                             |
| Handle errors                 | [ERROR-HANDLING.md](ERROR-HANDLING.md)                                               |
| Ensure data isolation         | [DATA-ISOLATION.md](DATA-ISOLATION.md)                                               |

---

**Ready to build?** → Start with [QUICKSTART.md](QUICKSTART.md)
