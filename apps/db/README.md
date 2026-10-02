# Database

Supabase PostgreSQL database configuration, migrations, and schema definitions for Sobremesa.

## Running the Supabase CLI

Use the Nx targets in `project.json` instead of calling `supabase` directly:

```
bun nx run db:start
bun nx run db:stop
bun nx run db:status
bun nx run db:reset
bun nx run db:push
bun nx run db:pull
bun nx run db:diff
bun nx run db:migration-new
bun nx run db:migration-list
```

These run with `apps/db` as the working directory, which is where the real config
(`supabase/config.toml`) and migrations live.
Nx also loads the root `.env` into these tasks, so a relative `SUPABASE_WORKDIR` there (e.g.
`apps/db`) resolves to `apps/db/apps/db` and every target fails with `failed to change workdir`.
Leave it unset or make it absolute. Likewise, don't put `SUPABASE_PROJECT_ID` in the root `.env`:
the CLI reads it as an override for the local `project_id`, so local commands look for containers
named after the hosted project ref and fail. CI sets it only for `supabase link --project-ref`.

If you do need the raw CLI, `cd apps/db` first. Running a bare `supabase` command from elsewhere
(e.g. the repo root) makes the CLI create a stray, empty `supabase/` state folder (`.branches`,
`.temp`, `snippets`) wherever it was invoked.

## Migration policy (local-dev-only phase)

While this project has no real users, we deliberately keep a single migration file
(`supabase/migrations/20260112074715_init_schema.sql`) instead of accumulating incremental
migrations: new schema changes are folded directly into that file rather than added as a new
migration, and any migration files that had been added since are deleted in the same change.

Because the init migration keeps its version, editing it never reaches a database that already
applied it: `supabase db push` and `supabase migration up` see nothing new and succeed without
changing anything. (Push fails only when the hosted history lists versions missing locally, e.g.
after older migration files were deleted.) So under this policy **a reset is the migration**:

- **Local:** `apps/db/scripts/rebuild-local.sh` backs up to `tmp/db-backups/`, resets, recreates the
  dev Studio identity, re-imports the Angelita fixture with recorded LLM responses (free when prompts
  are unchanged), and prints `sbm status`.
- **Hosted:** `supabase db reset --linked` (destroys hosted data), or `supabase migration repair`
  plus hand-applied DDL to keep it. The deploy workflow's "Verify hosted schema matches migrations"
  step fails when the hosted schema has drifted, so a missed reset is visible.

Once real users exist, switch to normal incremental migrations and stop squashing.
