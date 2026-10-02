> [!NOTE]
> **Agent working memory:** Read [`.agents/README.md`](.agents/README.md) before
> non-trivial work — coding or not — and keep it current as you go. It holds private
> working state; it does not replace the project's designated shared sources of truth.

# Contributor Agent Guide

This file is for AI coding agents and contributors working in this repository.

## Source of Truth

- `spec/` is canonical: descriptive system behavior at the root (updated in the same change as
  code), normative product requirements in `spec/product/` (changed only by deliberate product
  decision).
- `docs/` contains onboarding material and historical ADRs. Nothing in `docs/` is canonical.
- If `docs/` conflicts with `spec/`, update or trust `spec/`.
- ADRs in `docs/decisions/` are historical decisions. Do not rewrite them to match current
  behavior; add a new ADR if a new architectural decision needs to be recorded.

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
  - `apps/eval`: local-only web app for comparing Scribe extraction across
    LLMs/models (side-by-side diffing, run history, annotation). Reuses
    `libs/evals`'s Tier-1 runner/scorer; writes nothing to canonical tables.
  - `apps/cli`: local dev CLI (`sbm import` / `sbm process`), run directly with `bun` (no build
    step) or installed globally via `bun link` (see `apps/cli/README.md`). Imports a chat export
    (format via `--source` or auto-detected; WhatsApp is the only one with a parser today) and
    drains the processing queue through the live pipeline via `libs/pipeline`.
- Core libraries:
  - `libs/agents/*`: Intern, Scribe, Registrar, Historian, Facilitator, Admin, Curator.
  - `libs/database`: Supabase repositories and data services.
  - `libs/import` and `libs/import-utils`: WhatsApp import workflow.
  - `libs/queue`: ordered processing queue and `MessageProcessor`.
  - `libs/pipeline`: `buildMessagePipeline()` — the one shared way to wire agents onto a
    `MessageProcessor` by explicit stage selection; used by `apps/chatbots`, `libs/evals`'s
    pipeline-snapshot runner, and `apps/cli`.
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
  built) or private working notes (if pending). When implementation departs from an ADR, mark it
  Superseded with a dated note and, if a real decision replaced it, record the new decision as a
  new ADR.
- ADRs never link to private, ephemeral planning material — describe or name the pending work in
  prose instead.

## Git

- Never switch branches without first notifying the developer: say which branch you are on, which
  branch you are switching to, and why. This includes creating and checking out a new branch.

## Style Notes

- Follow existing TypeScript and repository patterns before introducing new abstractions.
- Use existing repositories/services instead of raw Supabase calls where a suitable abstraction exists.
- Keep edits scoped; avoid opportunistic refactors.
- For frontend work, match the existing Solid.js/CSS style and verify responsive behavior where UI
  changes are visible.

## Presenting Findings and Decisions

Applies to messages that report analysis, offer options, or revise a recommendation — not
to `.agents/` notes, which may stay dense.

- Lead with the plain-language problem before jargon, ADR numbers, or code refs — those are
  supporting evidence, not the opener.
- Define a term on first use or drop it; don't assume prior context from the investigation.
- Prefer a concrete example over naming the abstract mechanism.
- If a recommendation changed, say what changed and why in one plain sentence before
  re-presenting options.
