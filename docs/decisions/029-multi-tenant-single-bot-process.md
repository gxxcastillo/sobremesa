# ADR-029: Multi-Tenant Single Bot Process

## Status

Accepted

## Date

2026-07-02

## Context

[ADR-021](021-one-bot-per-family.md) proposed one bot instance (one process, one `FAMILY_ID`) per
family. That model was never the deployed architecture beyond the ADR itself: the "refactor: single
bot architecture with Intern routing" commit (~2026-01-14, days after ADR-021) moved the system to a
single bot process that serves every family, and it has stayed that way since. This ADR records the
decision actually acted on, superseding ADR-021.

## Decision

Run one bot process for all families:

- A single Telegraf `BotManager` (`libs/telegram/src/lib/bot-manager.ts`) holds one
  `TELEGRAM_BOT_TOKEN` and long-polls for every group the bot has been added to.
- The `families` table is multi-tenant: one row per family, each with its own `chat_source`/
  `chat_id` and JSONB `config` (display names, personality, cultural terms, language).
- `family_id` is the isolation boundary enforced in queries and RLS, not process boundaries.
- Per-family loops (e.g. the Facilitator's `askQuestionsForAllFamilies`) iterate active families
  from within the one process rather than being sharded across processes.

## Consequences

### Positive

- One deployable unit to operate, deploy, and monitor instead of one per family.
- New families onboard by inserting a row, not provisioning infrastructure.
- Matches the actual multi-tenant Fly.io deployment (`sobremesa-chatbots`, one process).

### Negative

- A bug or crash in the shared process can affect every family, not just one.
- Family isolation now depends entirely on `family_id` scoping in code/RLS rather than physical
  process separation.

### Trade-off

Operational simplicity and realistic infra cost at current scale outweigh per-family process
isolation. Revisit if/when a single-instance design stops scaling; a "single-instance by design
until N families" decision is expected as a future ADR once that scaling boundary is worked out.
