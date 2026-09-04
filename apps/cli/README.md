# CLI

`sbm import` / `sbm process` -- local dev CLI, run directly with `bun` (no build step, same shape
as `apps/db`).

Install the `sbm` command globally once, via [`bun link`](https://bun.sh/docs/cli/link):

```bash
cd apps/cli && bun link   # symlinks `sbm` into bun's global bin dir
```

Then, from anywhere:

```bash
sbm import <path-to-export> [--source=<format>] --family-name="The Ramirez Family" [options]
sbm process [options]
sbm <command> --help   # full flag list, auto-generated
```

Or without installing, run it directly with `bun`:

```bash
bun apps/cli/src/main.ts import <path-to-export> [--source=<format>] --family-name="The Ramirez Family" [options]
bun apps/cli/src/main.ts process [options]
bun apps/cli/src/main.ts <command> --help
```

Argument parsing and subcommand dispatch use [`citty`](https://www.npmjs.com/package/citty)
(the one 3rd-party CLI-parsing dependency in the repo -- every other script hand-rolls `argv`
parsing, but a two-subcommand CLI with many flags each warranted real parsing/usage generation).
Each flag accepts either its camelCase form (`--familyName=`) or the kebab-case form shown in
`--help` (`--family-name=`) -- citty registers both automatically.

`import` parses a chat export -- format given via `--source` or auto-detected (WhatsApp is the
only one with a parser today; see `src/commands/import.ts`) -- creates the family/import job,
classifies each message process/skip, and enqueues the "process" ones for Scribe. `process`
dequeues and processes everything currently queued through the real live pipeline (`@sobremesa/pipeline`'s
`buildMessagePipeline`) -- Intern router/filter/image-linker, then Scribe, then Registrar. See
each command's own file (`src/commands/import.ts`, `src/commands/process.ts`) for the full flag
definitions; both are manual-only, not part of `test:all`/CI, and require `bun nx run db:start`
first.

Successor to `scripts/import-fixture.ts`, split into two composable commands so import and process
run and retry independently, and rebuilt on `buildMessagePipeline` so a process run now runs messages
through Intern's real classification instead of skipping it -- see
`libs/pipeline`.
