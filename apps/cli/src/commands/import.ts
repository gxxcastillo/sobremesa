/**
 * `sbm import <path-to-export> [--source=<format>] --family-name="..." [options]`
 *
 * Loads a real chat export as a local family import. Drives the same
 * `ImportProcessor` the Studio import wizard and `apps/api/src/routes/
 * import.ts` use, end to end against the local DB directly -- no Studio, no
 * auth, no manual review clicking. Intended for reloading your own family
 * export after a DB reset, not for the family-facing import UX.
 *
 * Export format: `--source` picks a parser explicitly, or it's
 * auto-detected. WhatsApp is the only format with a parser today;
 * `ImportSource` (the data model's source enum) also names 'telegram' and
 * 'other' for formats not yet implemented -- see
 * `resolveImportSource` (`libs/import-utils`, shared with
 * `apps/api/src/routes/import.ts` and `ImportProcessor` so all three import
 * entry points resolve a source the same way) for how those fail (clearly,
 * not silently) if requested.
 *
 * Steps:
 *   1. Parse the export and create an import job + family + participants
 *      (ImportProcessor, same as production).
 *   2. Enqueue every parsed event unconditionally -- no pre-queue skip/
 *      process decision, matching live's `MessageIngester` (see
 *      `.agents/plans/import-filter-convergence-plan.md`). There is no
 *      local-dev equivalent of Studio's human-review step, so `sbm process`
 *      (run separately) is where Intern's real router/filter actually
 *      judges each message -- in the same pass as Scribe/Registrar, exactly
 *      like a live message gets router->filter->scribe->registrar in one
 *      `MessageProcessor.process()` call. This command no longer touches
 *      `intern_decisions` at all (that table is Studio-review-specific).
 *
 * Messages are left queued -- run `sbm process` separately to process
 * them. (Earlier versions of this tool, `scripts/import-fixture.ts`, drained
 * automatically unless `--no-drain` was passed; splitting import and process
 * into separate commands makes that the only shape now.)
 *
 * Manual-only -- not part of test:all/CI (per AGENTS.md; no live-DB test runs
 * in CI today). Requires `bun nx run db:start` first.
 *
 * Every run appends one JSON line to fixtures/run-results/cli-import.jsonl
 * (gitignored, under the already-ignored /fixtures) so results are
 * comparable across runs.
 *
 * Flags are parsed by `citty` (see `importCommand` below); run
 * `sbm import --help` for the generated usage.
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { defineCommand } from 'citty';
import { createLiveDbClient } from '../db-client';
import { ImportJobRepository, ImportProcessor } from '@sobremesa/import';
import {
  ConversationEventRepository,
  IdentityRepository,
  ProcessingQueueRepository,
} from '@sobremesa/database';
import {
  ALL_IMPORT_SOURCES,
  SUPPORTED_IMPORT_SOURCES,
  resolveImportSource,
} from '@sobremesa/import-utils';
import { type LanguageCode } from '@sobremesa/shared-types';
import { appendRunLog } from '../run-log';

export interface ImportOptions {
  filePath: string;
  familyName: string;
  source?: string;
  language?: LanguageCode;
  timezone?: string;
  identityId?: string;
  allowRemoteDb: boolean;
}

export const importCommand = defineCommand({
  meta: {
    name: 'import',
    description:
      'Load a chat export as a local family import (does not process the queue -- run `sbm process` separately).',
  },
  args: {
    path: {
      type: 'positional',
      description: 'Path to the chat export file',
      required: true,
    },
    familyName: {
      type: 'string',
      description: 'Family display name',
      required: true,
    },
    source: {
      type: 'string',
      description: `Export format (${ALL_IMPORT_SOURCES.join('|')}). Default: auto-detected from the file (currently only ${SUPPORTED_IMPORT_SOURCES.join(', ')} has a parser).`,
    },
    language: {
      type: 'string',
      description: 'Default: auto-detected from the export (en/es/pt/fr/de)',
    },
    timezone: {
      type: 'string',
      description: "Default: this machine's timezone",
    },
    identityId: {
      type: 'string',
      description:
        'Identity to grant family admin access to. Default: auto-resolved if exactly one identity exists locally.',
    },
    allowRemoteDb: {
      type: 'boolean',
      description: 'Required to target a non-local SUPABASE_URL',
      default: false,
    },
  },
  async run({ args }) {
    await runImport({
      filePath: args.path,
      familyName: args.familyName,
      source: args.source,
      language: args.language as LanguageCode | undefined,
      timezone: args.timezone,
      identityId: args.identityId,
      allowRemoteDb: args.allowRemoteDb,
    });
  },
});

async function resolveIdentityId(
  client: ReturnType<typeof createLiveDbClient>,
  explicit: string | undefined,
): Promise<string> {
  if (explicit) return explicit;

  const identities = await new IdentityRepository(client).findAllActive();

  if (identities.length === 0) {
    throw new Error(
      'No identities exist in the local DB yet, so there is no one to grant ' +
        'family access to. Log into Studio once (bun nx serve studio) to create ' +
        'your account, then re-run this command -- or pass --identity-id=<uuid>.',
    );
  }
  if (identities.length > 1) {
    const listing = identities
      .map(
        (i) =>
          `  ${i.id}  ${i.displayName ?? i.providerUsername ?? '(unnamed)'}`,
      )
      .join('\n');
    throw new Error(
      `Multiple identities exist; pass --identity-id=<uuid> to pick one:\n${listing}`,
    );
  }
  return identities[0].id;
}

const RUN_LOG_PATH = path.join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'run-results',
  'cli-import.jsonl',
);

export async function runImport(options: ImportOptions): Promise<void> {
  const startedAt = Date.now();
  const client = createLiveDbClient('Chat import', options.allowRemoteDb);

  const summary: Record<string, unknown> = {};
  let error: string | undefined;

  try {
    const rawFileContent = fs.readFileSync(options.filePath, 'utf-8');
    const { source, parsed } = resolveImportSource(
      rawFileContent,
      options.source,
    );
    if (parsed.messages.length === 0) {
      throw new Error(
        `No messages found in export -- is this a valid ${source} export?`,
      );
    }
    console.log(
      `Source: ${source}${options.source ? '' : ' (auto-detected)'}. Parsed ` +
        `${parsed.messages.length} messages from ${parsed.participants.length} participants ` +
        `(${parsed.stats.dateRange.start} to ${parsed.stats.dateRange.end}).`,
    );

    const identityId = await resolveIdentityId(client, options.identityId);
    const timezone =
      options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const language = options.language ?? parsed.detectedLanguages[0] ?? 'en';

    const jobRepo = new ImportJobRepository(client);
    const job = await jobRepo.create({
      createdBy: identityId,
      source,
      config: {
        family: {
          name: options.familyName,
          defaultLanguage: language,
          timezone,
        },
        participants: parsed.participants.map((p) => ({
          rawName: p.rawName,
          displayName: p.suggestedDisplayName,
          timezone,
          role: 'member',
        })),
      },
      rawFileContent,
      messageCount: parsed.messages.length,
    });
    console.log(`Created import job ${job.id}.`);
    Object.assign(summary, {
      jobId: job.id,
      familyName: options.familyName,
      messagesParsed: parsed.messages.length,
      participants: parsed.participants.length,
    });

    console.log('\n=== Inserting conversation events ===\n');
    await new ImportProcessor({ dbClient: client }).processJob(job.id);

    const imported = await jobRepo.findById(job.id);
    if (!imported?.familyId || !imported.conversationId) {
      throw new Error('Import finished without a familyId/conversationId.');
    }
    summary['familyId'] = imported.familyId;
    console.log(
      `Family ${imported.familyId} ready; status: ${imported.status}.`,
    );

    console.log('\n=== Enqueueing messages for processing ===\n');
    // No pre-queue skip/process decision -- every parsed event gets queued
    // unconditionally, matching live's MessageIngester. `sbm process` (run
    // separately) is where Intern's real router/filter judges each message,
    // in the same pass as Scribe/Registrar.
    const eventRepo = new ConversationEventRepository(client);
    const eventIds = await eventRepo.findAllIdsInConversation(
      imported.familyId,
      imported.conversationId,
    );

    const queueRepo = new ProcessingQueueRepository(client);
    for (const eventId of eventIds) {
      await queueRepo.enqueue(imported.familyId, eventId);
    }

    await jobRepo.update(job.id, {
      status: 'complete',
      progress: {
        current: eventIds.length,
        total: eventIds.length,
        stage: `Queued ${eventIds.length} messages for processing`,
      },
      completedAt: new Date(),
    });
    console.log(`Queued ${eventIds.length} messages.`);
    summary['queued'] = eventIds.length;
    console.log(
      `\nRun "sbm process --family-id=${imported.familyId}" (batch-seeding scope) ` +
        'or plain "sbm process" to process them.',
    );
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    appendRunLog(RUN_LOG_PATH, {
      mode: 'import',
      durationMs: Date.now() - startedAt,
      completed: error === undefined,
      error,
      import: summary,
    });
  }
}
