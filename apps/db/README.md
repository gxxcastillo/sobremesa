# Database

Supabase PostgreSQL database configuration, migrations, and schema definitions for Sobremesa.

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
