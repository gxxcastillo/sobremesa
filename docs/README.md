# Sobremesa Docs

`spec/` is the canonical description of current system behavior. The files in this directory are
product guidance, onboarding material, and historical ADRs.

If a technical detail in `docs/` conflicts with `spec/`, trust `spec/`.

## Start Here

1. [../spec/README.md](../spec/README.md) - current technical specification
2. [PRODUCT.md](PRODUCT.md) - product definition and non-negotiables
3. [QUICKSTART.md](QUICKSTART.md) - local development setup
4. [WARMTH.md](WARMTH.md) and [CULTURE.md](CULTURE.md) - product voice and adaptation guidance

## Canonical Technical Spec

| Need to understand...                                        | Canonical file                                                                     |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| System shape, apps, libraries, invariants                    | [../spec/overview.md](../spec/overview.md)                                         |
| Schema, claims, relationships, queues, imports, RLS          | [../spec/data-model.md](../spec/data-model.md)                                     |
| Agent responsibilities and pipeline order                    | [../spec/agent-pipeline.md](../spec/agent-pipeline.md)                             |
| Telegram ingestion, queue processing, outbound flow, imports | [../spec/message-lifecycle.md](../spec/message-lifecycle.md)                       |
| AI provider abstraction, prompts, model tiers                | [../spec/ai-providers-and-prompts.md](../spec/ai-providers-and-prompts.md)         |
| Identity, auth, API, Studio routes                           | [../spec/identity-auth-and-interfaces.md](../spec/identity-auth-and-interfaces.md) |

## Docs Kept Here

| File                                                 | Status                                                   |
| ---------------------------------------------------- | -------------------------------------------------------- |
| [PRODUCT.md](PRODUCT.md)                             | Product guidance                                         |
| [WARMTH.md](WARMTH.md)                               | Product voice guidance                                   |
| [CULTURE.md](CULTURE.md)                             | Cultural adaptation guidance                             |
| [QUICKSTART.md](QUICKSTART.md)                       | Local setup guide                                        |
| [TECH-STACK.md](TECH-STACK.md)                       | Developer setup/reference; defer to `spec/` for behavior |
| [NX-MONOREPO-STRUCTURE.md](NX-MONOREPO-STRUCTURE.md) | Workspace orientation                                    |
| [adr/](adr/)                                         | Historical architecture decisions                        |
