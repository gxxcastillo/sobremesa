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

If you do need the raw CLI, `cd apps/db` first. Running a bare `supabase` command from elsewhere
(e.g. the repo root) makes the CLI create a stray, empty `supabase/` state folder (`.branches`,
`.temp`, `snippets`) wherever it was invoked.

## Migration policy (local-dev-only phase)

While this project has no real users, we deliberately keep a single migration file
(`supabase/migrations/20260112074715_init_schema.sql`) instead of accumulating incremental
migrations: new schema changes are folded directly into that file rather than added as a new
migration, and any migration files that had been added since are deleted in the same change.

This means the hosted Supabase project's migration history will drift from the local migration
directory each time a squash happens. Before the next `supabase db push` after a squash, reconcile
the hosted project (`supabase db reset --linked`, or `supabase migration repair` if you want to keep
existing hosted data) so `supabase_migrations.schema_migrations` matches the single local migration
again. `supabase db push` will fail on a version-history mismatch otherwise.

Once real users exist, switch to normal incremental migrations and stop squashing.
