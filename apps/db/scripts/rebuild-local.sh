#!/usr/bin/env bash
# Rebuild the LOCAL dev database from the current migration and re-import the
# Angelita fixture. Under the single-migration policy (README "Migration
# policy"), editing the init migration never reaches an existing database --
# a reset is the migration. Local only: every Supabase call is --local, and
# the CLI's own guard refuses a non-local SUPABASE_URL.
#
#   apps/db/scripts/rebuild-local.sh [family-name]
#
# 1. Backs up schema + data to tmp/db-backups/<timestamp>/.
# 2. `supabase db reset` (local).
# 3. Recreates the dev Studio identity ("Gabriel (dev)", the one dev login
#    creates) so `sbm import` has someone to grant access to.
# 4. `sbm import` the fixture, then `sbm process --responseReplay` -- recorded
#    responses in tmp/llm-response-replay.db make this free when the prompts
#    are unchanged; a cache miss is a real, paid Anthropic call.
# 5. `sbm status` for the new family.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
# Run the Supabase CLI from apps/db (its project dir). A relative
# SUPABASE_WORKDIR from .env would resolve against that cwd and break it.
unset SUPABASE_WORKDIR
supa() { (cd "$ROOT/apps/db" && supabase "$@"); }

FIXTURE="fixtures/02-09-2026-whatsapp-angelita-import/_chat.txt"
FAMILY_NAME="${1:-Angelita Rebuild $(date +%Y-%m-%d)}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="tmp/db-backups/$STAMP"
DB_CONTAINER="supabase_db_sobremesa"
SBM=(bun apps/cli/src/main.ts)

[[ -f "$FIXTURE" ]] || { echo "Missing fixture $FIXTURE (gitignored; local copy required)" >&2; exit 1; }

echo "== Backing up local DB to $BACKUP_DIR"
mkdir -p "$BACKUP_DIR"
supa db dump --local -f "$ROOT/$BACKUP_DIR/schema.sql"
supa db dump --local --data-only -f "$ROOT/$BACKUP_DIR/data.sql"

echo "== Resetting local DB"
supa db reset --local

echo "== Recreating the dev identity"
docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO public.users (id, display_name, role)
VALUES ('4ff38f3d-2750-4c11-a33e-4aa8c7c59f74', 'Gabriel (dev)', 'super_admin');
INSERT INTO public.identities (id, user_id, provider, provider_user_id, display_name, is_active)
VALUES ('32d06df2-fd56-4a3a-8cb2-7ebcccf501ca', '4ff38f3d-2750-4c11-a33e-4aa8c7c59f74',
        'telegram', '100001', 'Gabriel (dev)', true);
SQL

echo "== Importing $FIXTURE as \"$FAMILY_NAME\""
IMPORT_OUT="$("${SBM[@]}" import "$FIXTURE" --familyName="$FAMILY_NAME" \
  --language=es --timezone=America/Los_Angeles 2>&1 | tee /dev/stderr)"
FAMILY_ID="$(grep -oE 'Family [0-9a-f-]{36} ready' <<<"$IMPORT_OUT" | awk '{print $2}')"
[[ -n "$FAMILY_ID" ]] || { echo "Could not read the new family id from sbm import output" >&2; exit 1; }

echo "== Processing family $FAMILY_ID (replaying recorded responses)"
"${SBM[@]}" process --family-id="$FAMILY_ID" --responseReplay
tail -1 fixtures/run-results/cli-process.jsonl

echo "== Status"
"${SBM[@]}" status --family-id="$FAMILY_ID"
echo "Backup: $BACKUP_DIR  Family: $FAMILY_ID"
