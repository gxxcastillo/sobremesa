# Contributor Agent Guide

This file is for AI coding agents and contributors working in this repository.

## Source of Truth

- `spec/` is canonical: descriptive system behavior at the root (updated in the same change as
  code), normative product requirements in `spec/product/` (changed only by deliberate product
  decision).
- `docs/` contains onboarding material and historical ADRs. Nothing in `docs/` is canonical.
- If `docs/` conflicts with `spec/`, update or trust `spec/`.
- ADRs in `docs/adr/` are historical decisions. Do not rewrite them to match current behavior; add a
  new ADR if a new architectural decision needs to be recorded.

## First Reads

Before changing behavior, read the relevant spec file:

- System shape and invariants: [spec/overview.md](spec/overview.md)
- Schema, queues, imports, RLS: [spec/data-model.md](spec/data-model.md)
- Agent pipeline: [spec/agent-pipeline.md](spec/agent-pipeline.md)
- Ingestion and queue lifecycle: [spec/message-lifecycle.md](spec/message-lifecycle.md)
- AI providers and prompts: [spec/ai-providers-and-prompts.md](spec/ai-providers-and-prompts.md)
- Auth, API, Studio: [spec/identity-auth-and-interfaces.md](spec/identity-auth-and-interfaces.md)

## Project Shape

- Runtime/package manager: Bun.
- Monorepo: Nx with Bun workspaces.
- Apps:
  - `apps/chatbots`: Telegram bot and live processing pipeline.
  - `apps/api`: Elysia REST API for Studio.
  - `apps/studio`: Solid.js web app.
  - `apps/db`: Supabase migrations/config.
- Core libraries:
  - `libs/agents/*`: Intern, Scribe, Registrar, Historian, Facilitator, Admin, Curator.
  - `libs/database`: Supabase repositories and data services.
  - `libs/import` and `libs/import-utils`: WhatsApp import workflow.
  - `libs/queue`: ordered processing queue and `MessageProcessor`.
  - `libs/ai-provider`: provider abstraction.
  - `libs/prompts`: prompt templates.

## Commands

Use the narrowest command that verifies your change:

```bash
bun nx test <project>
bun nx lint <project>
bun nx types <project>
```

Broad checks:

```bash
bun run test:all
bun run lint:all
bun run types:all
bun run check:all
```

Docs-only changes should at least pass:

```bash
git diff --check
```

## Implementation Rules

- Preserve family isolation. Family-scoped reads and writes must be constrained by `family_id`.
- Preserve immutable provenance. Do not update/delete `conversation_events` or immutable claim fields;
  use processing, redaction, analysis, or status tables as specified.
- Keep Registrar as the single writer for core extracted entities/claims in the live pipeline.
- Preserve conflicting memories as data. Do not auto-resolve or erase contradictory claims.
- Favor precision over recall in entity matching. False merges are worse than duplicate entities.
- Queue processing must remain ordered and sequential per family.
- If behavior changes, update `spec/` in the same change.

## Documentation Rules

- Put current behavior in `spec/`.
- Keep product requirements (`spec/product/product.md`, `warmth.md`, `culture.md`) normative:
  change them only by deliberate product decision, and record such a change as a new ADR.
- Keep `docs/QUICKSTART.md` as the onboarding and setup guide.
- Do not add new parallel technical specs under `docs/`; add to `spec/` or create a redirect.
- An ADR records a decision that was made and acted on. Desired behavior belongs in `spec/` (if
  built) or an `.agents/` plan (if pending). When implementation departs from an ADR, mark it
  Superseded with a dated note and, if a real decision replaced it, record the new decision as a
  new ADR.
- ADRs never link to `.agents/` (ephemeral, gitignored, reorganized freely) — describe or name the
  pending work in prose instead. `.agents/` plans may link to ADRs.

## Style Notes

- Follow existing TypeScript and repository patterns before introducing new abstractions.
- Use existing repositories/services instead of raw Supabase calls where a suitable abstraction exists.
- Keep edits scoped; avoid opportunistic refactors.
- For frontend work, match the existing Solid.js/CSS style and verify responsive behavior where UI
  changes are visible.
