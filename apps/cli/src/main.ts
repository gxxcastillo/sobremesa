#!/usr/bin/env bun
/**
 * sbm -- local dev CLI.
 *
 * Drives the same libs the Telegram bot and Studio import wizard use
 * (`@sobremesa/pipeline`'s `buildMessagePipeline`, `ImportProcessor`) end to
 * end against the local DB -- no Studio, no Telegram, no auth. Successor to
 * `scripts/import-fixture.ts`, split into two composable subcommands so
 * import and process can be run and retried independently.
 *
 * Usage (once installed globally, see apps/cli/README.md):
 *   sbm import <path-to-export> [--source=<format>] --family-name="..." [options]
 *   sbm process [options]
 *   sbm <command> --help
 *
 * Or directly, without installing:
 *   bun apps/cli/src/main.ts import <path-to-export> [--source=<format>] --family-name="..." [options]
 *   bun apps/cli/src/main.ts process [options]
 *
 * Argument parsing/dispatch is handled by `citty`; see `import.ts` and
 * `process.ts` for each subcommand's flag definitions.
 */
import { defineCommand, runMain } from 'citty';
import { importCommand } from './commands/import';
import { processCommand } from './commands/process';

const main = defineCommand({
  meta: {
    name: 'sbm',
    version: '0.0.1',
    description: 'Sobremesa local dev CLI',
  },
  subCommands: {
    import: importCommand,
    process: processCommand,
  },
});

runMain(main);
