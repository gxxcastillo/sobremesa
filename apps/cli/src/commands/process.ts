/**
 * `sbm process [options]`
 *
 * Dequeues and processes everything currently queued for Scribe, through the
 * same Intern router/filter/image-linker -> Scribe -> Registrar pipeline the
 * live Telegram bot uses (`buildMessagePipeline`), instead of the
 * Scribe/Registrar-only shape this used to have (formerly `sbm drain`).
 * That's the point: messages queued via `sbm import` now get Intern's real
 * classification, matching what a real imported family experiences once
 * queued, rather than skipping Intern's live filter entirely.
 *
 * No `facilitatorNudge` stage and no `messageSender` -- an import-triggered
 * process run can never trigger an outbound question send.
 *
 * `--family-id`, when given, scopes the run itself to that family -- it
 * never claims another family's queued work while it runs. (It also still
 * scopes the `--response-replay-batch` seeding step below.) Omitted, it
 * processes the entire shared `processing_queue` across every family with
 * anything queued, same as before.
 *
 * `--stages=<comma-list>` picks which `PipelineStage`s run, e.g.
 * `--stages=router,filter,imageLinker` runs Intern only -- Scribe and
 * Registrar are simply never wired, so `processor.ts`'s existing `if
 * (this.scribe && shouldProcess)`/`if (this.registrar && domainModel)`
 * guards no-op cleanly instead of erroring. That combination is useful to
 * record Intern's raw responses (see recording below) for messages that
 * already have a complete, expensive Scribe recording elsewhere, without
 * paying for Scribe again. Deliberately goes through the same
 * `buildMessagePipeline` path as an ordinary run rather than calling Intern
 * directly: Intern's own context-fetch fallback (used when no context is
 * pre-supplied) orders recent messages and falls back on missing sender
 * names differently than `MessageProcessor`'s shared `fetchContext` does, so
 * a standalone call would render a different prompt than a real run and
 * silently record cache entries that can never be replayed. No stage
 * combination here covers Intern's `linkToImage` fallback call -- that only
 * fires from within Scribe's own path, so it can't be seeded without Scribe
 * running. Default (no `--stages`): `router,filter,imageLinker,scribe,
 * registrar`, same as before this flag existed. `admin`/`historian`/
 * `facilitatorNudge` are valid `PipelineStage`s but this command never
 * supplies a `messageSender`, so requesting them fails immediately with
 * `buildMessagePipeline`'s own clear error rather than this command
 * special-casing them. `storyFollowup` is likewise valid but this command
 * never supplies a `followup` provider/model, so requesting it fails the
 * same eager-validation way.
 *
 * `--limit=N` stops after N messages have been attempted (success or
 * failure both count), even if more are queued -- cheap to try a change on
 * a handful of messages before committing to a full run. `--dry-run` prints
 * what would be attempted (family, stage set, matching event ids, first 20
 * shown) without calling any provider, writing to the queue, or requiring
 * `ANTHROPIC_API_KEY` -- it reads `processing_queue` directly rather than
 * calling `dequeueAny`, since that RPC claims/locks a row rather than
 * peeking at it. `--event-id=<comma-list>` processes exactly those event
 * ids directly (`processor.process(eventId, familyId)`) instead of draining
 * in queue order -- for reproducing or debugging one specific message. It
 * does not skip the queue's own bookkeeping: if a given event still has a
 * live queue row (queued, or a stale processing row), that row gets
 * completed/failed exactly like the normal loop does, so a later run can't
 * dequeue and reprocess the same event -- Scribe/Registrar are not
 * idempotent on a repeat pass (claims are never deduplicated, only
 * entities are), so leaving a stale row behind would risk real duplicate
 * data, not just untidy state. An event with no queue row at all (never
 * enqueued, or already completed earlier) has nothing to update, which is
 * the only case this is genuinely a no-op on the queue. Requires
 * `--family-id` (all given ids must belong to that one family).
 *
 * Recording is on by default: every Intern/Scribe call this run makes gets
 * its raw request/response saved to `tmp/llm-response-replay.db` (override
 * with `--response-replay-db`), whether or not `--response-replay` is also
 * passed -- recording never changes what a call returns, so there's no
 * downside to always having it, and it's what makes a live run's raw
 * input/output recoverable afterward instead of gone the moment the run
 * ends. Pass `--no-record` to skip the write entirely. `--response-replay`
 * is the separate, still-opt-in decision to substitute a stored response for
 * an identical call instead of calling Anthropic.
 *
 * Manual-only -- not part of test:all/CI. Requires `bun nx run db:start` and
 * `ANTHROPIC_API_KEY` (both Intern and Scribe call a live provider).
 *
 * Every run appends one JSON line to fixtures/run-results/cli-process.jsonl
 * (gitignored, under the already-ignored /fixtures), including whether
 * recording/replay were on and each provider's hit/miss counts.
 *
 * Flags are parsed by `citty` (see `processCommand` below); run
 * `sbm process --help` for the generated usage. `--response-replay-batch`
 * additionally requires `--family-id` (validated at the top of `runProcess`,
 * since it's a cross-flag rule citty's per-arg schema can't express).
 */
import 'dotenv/config';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { defineCommand } from 'citty';
import { createLiveDbClient } from '../db-client';
import { ProcessingQueueRepository } from '@sobremesa/database';
import { buildMessagePipeline, type PipelineStage } from '@sobremesa/pipeline';
import type { QueueIntent } from '@sobremesa/shared-types';
import {
  ScribeAgent,
  buildScribeCompletionRequest,
} from '@sobremesa/agents-scribe';
import {
  loadAIConfig,
  createAIProviderFactory,
  CachingProvider,
  SqliteDevResponseCacheStore,
  hashCompletionRequest,
  submitAnthropicBatchAndWait,
  type AIProvider,
  type AICompletionRequest,
  type AICompletionResponse,
} from '@sobremesa/ai-provider';
import { appendRunLog } from '../run-log';

export interface ProcessOptions {
  responseReplay: boolean;
  responseReplayDb: string | undefined;
  responseReplayBatch: boolean;
  noRecord: boolean;
  familyId: string | undefined;
  modelOverride: string | undefined;
  internModelOverride: string | undefined;
  stages: string | undefined;
  limit: number | undefined;
  dryRun: boolean;
  eventIds: string[];
  allowRemoteDb: boolean;
  intent: string | undefined;
}

/** Valid `processing_queue.intent` values -- see `--intent` below. */
export const ALL_QUEUE_INTENTS: QueueIntent[] = ['live', 'import'];

/**
 * Parses `--intent` (comma-separated), defaulting to no filter (claims any
 * intent -- today's behavior). `undefined` means "no restriction", distinct
 * from an empty array.
 */
export function parseIntentFilter(
  raw: string | undefined,
): QueueIntent[] | undefined {
  if (!raw) return undefined;
  const tokens = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const invalid = tokens.filter(
    (t) => !ALL_QUEUE_INTENTS.includes(t as QueueIntent),
  );
  if (invalid.length > 0) {
    throw new Error(
      `Unknown --intent value(s): ${invalid.join(', ')}. Valid intents: ${ALL_QUEUE_INTENTS.join(', ')}.`,
    );
  }
  return tokens as QueueIntent[];
}

export const ALL_PIPELINE_STAGES: PipelineStage[] = [
  'admin',
  'router',
  'filter',
  'imageLinker',
  'scribe',
  'registrar',
  'historian',
  'facilitatorNudge',
  'storyFollowup',
];

export const DEFAULT_PROCESS_STAGES: PipelineStage[] = [
  'router',
  'filter',
  'imageLinker',
  'scribe',
  'registrar',
];

/** Parses `--stages`, defaulting to `DEFAULT_PROCESS_STAGES` when omitted. */
export function parseStages(raw: string | undefined): Set<PipelineStage> {
  if (!raw) return new Set(DEFAULT_PROCESS_STAGES);
  const tokens = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const invalid = tokens.filter(
    (t) => !ALL_PIPELINE_STAGES.includes(t as PipelineStage),
  );
  if (invalid.length > 0) {
    throw new Error(
      `Unknown --stages value(s): ${invalid.join(', ')}. Valid stages: ${ALL_PIPELINE_STAGES.join(', ')}.`,
    );
  }
  return new Set(tokens as PipelineStage[]);
}

export const processCommand = defineCommand({
  meta: {
    name: 'process',
    description:
      'Dequeue and process everything currently queued through the live pipeline (router/filter/imageLinker/scribe/registrar by default -- see --stages).',
  },
  args: {
    familyId: {
      type: 'string',
      description:
        "Scope the run to this family only (never claims another family's queued work), and the family to seed with --response-replay-batch.",
    },
    allowRemoteDb: {
      type: 'boolean',
      description: 'Required to target a non-local SUPABASE_URL',
      default: false,
    },
    responseReplay: {
      type: 'boolean',
      description:
        'Substitute a locally recorded response (tmp/llm-response-replay.db) for any Intern/Scribe call identical to one already made, instead of calling Anthropic. Recording itself is on by default regardless of this flag -- see --no-record.',
      default: false,
    },
    responseReplayDb: {
      type: 'string',
      description:
        'Override the recorded-response file location (implies --response-replay)',
    },
    responseReplayBatch: {
      type: 'boolean',
      description:
        'Before processing, seed --response-replay by submitting every currently-queued Scribe prompt as one Anthropic Message Batch (half price, polls until done). Implies --response-replay. Requires --family-id.',
      default: false,
    },
    noRecord: {
      type: 'boolean',
      description:
        'Disable the default always-on recording of every Intern/Scribe raw request/response to tmp/llm-response-replay.db. Recording never changes what a call returns; disable only if you do not want the local DB write.',
      default: false,
    },
    model: {
      type: 'string',
      description:
        'Override the Scribe model for this run (both the batch submission and the run that replays it). Default: whatever AI_PROVIDER_SCRIBE config resolves to.',
    },
    internModel: {
      type: 'string',
      description:
        'Override the Intern model for this run. Default: whatever AI_PROVIDER_INTERN config resolves to. Matters for --response-replay: the model string is part of the cache key, so a drift between this and whatever model produced the cached entries is a silent cache miss.',
    },
    stages: {
      type: 'string',
      description: `Comma-separated PipelineStage list to run. Default: ${DEFAULT_PROCESS_STAGES.join(',')}. Valid: ${ALL_PIPELINE_STAGES.join(',')} (admin/historian/facilitatorNudge fail immediately -- this command supplies no messageSender). e.g. --stages=router,filter,imageLinker runs Intern only, at no Scribe cost.`,
    },
    limit: {
      type: 'string',
      description:
        'Stop after this many messages have been attempted (success or failure both count), even if more are queued.',
    },
    dryRun: {
      type: 'boolean',
      description:
        'Print what would be processed (family, stages, matching event ids) without calling any provider or touching the queue. No ANTHROPIC_API_KEY required.',
      default: false,
    },
    eventId: {
      type: 'string',
      description:
        "Comma-separated event id(s) to process directly instead of draining in queue order. Still completes/fails each one's queue row if it has one, so a later run cannot reprocess it. Requires --family-id.",
    },
    intent: {
      type: 'string',
      description: `Comma-separated processing_queue.intent list to claim (${ALL_QUEUE_INTENTS.join(',')}). Default: no restriction (claims any intent, today's behavior). --intent=live mirrors the always-on live poller's own exclusion of 'import'-owned rows; --intent=import claims only rows an import drain enqueued.`,
    },
  },
  async run({ args }) {
    await runProcess({
      responseReplay: args.responseReplay,
      responseReplayDb: args.responseReplayDb,
      responseReplayBatch: args.responseReplayBatch,
      noRecord: args.noRecord,
      familyId: args.familyId,
      modelOverride: args.model,
      internModelOverride: args.internModel,
      stages: args.stages,
      limit: args.limit ? Number(args.limit) : undefined,
      dryRun: args.dryRun,
      intent: args.intent,
      eventIds: args.eventId
        ? args.eventId
            .split(',')
            .map((s: string) => s.trim())
            .filter(Boolean)
        : [],
      allowRemoteDb: args.allowRemoteDb,
    });
  },
});

const RUN_LOG_PATH = path.join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'run-results',
  'cli-process.jsonl',
);

interface FamilyCounts {
  people: number;
  claims: number;
  stories: number;
  places: number;
  conflicts: number;
}

interface ProcessFamilyResult extends FamilyCounts {
  familyId: string;
  processed: number;
  failed: number;
}

/** Current people/claims/stories/places/conflicts counts for one family. */
async function getFamilyCounts(
  client: ReturnType<typeof createLiveDbClient>,
  familyId: string,
): Promise<FamilyCounts> {
  const countOf = async (table: string): Promise<number> => {
    const { count, error } = await client
      .from(table)
      .select('*', { count: 'exact', head: true })
      .eq('family_id', familyId);
    if (error) throw new Error(`Failed to count ${table}: ${error.message}`);
    return count ?? 0;
  };
  const [people, claims, stories, places, conflicts] = await Promise.all([
    countOf('people'),
    countOf('claims'),
    countOf('stories'),
    countOf('places'),
    countOf('claim_conflicts'),
  ]);
  return { people, claims, stories, places, conflicts };
}

/**
 * Builds the prompt for every currently-queued message in `familyId` and
 * submits them all as one Anthropic Message Batch (see
 * `--response-replay-batch` above), writing each successful result straight
 * into `store` so the run that follows replays it instead of calling
 * live. Anything already cached is skipped. Anything the batch didn't
 * produce a usable result for (errored/canceled/expired/missing) is left
 * uncached -- the following run just calls it live and caches it then,
 * same as an ordinary --response-replay miss, so one bad batch item never
 * loses the whole run.
 */
async function seedResponseReplayFromBatch(
  client: ReturnType<typeof createLiveDbClient>,
  familyId: string,
  model: string,
  anthropicClient: Anthropic,
  store: SqliteDevResponseCacheStore,
): Promise<void> {
  console.log(
    `\n=== Seeding --response-replay via Anthropic Batch API (family ${familyId}, model ${model}) ===\n`,
  );

  const { data: queued, error } = await client
    .from('processing_queue')
    .select('conversation_event_id')
    .eq('family_id', familyId)
    .eq('status', 'queued');
  if (error) {
    throw new Error(
      `Failed to list queued events for ${familyId}: ${error.message}`,
    );
  }
  const eventIds = [
    ...new Set((queued ?? []).map((r) => r['conversation_event_id'] as string)),
  ];
  if (eventIds.length === 0) {
    console.log('No queued events for this family -- nothing to seed.');
    return;
  }
  console.log(`Building prompts for ${eventIds.length} queued message(s)...`);

  // buildPrompt() never calls the provider -- see libs/evals's identical
  // UNUSED_PROVIDER stub for the same reason (apps/eval's prompt preview).
  const unusedProvider: AIProvider = {
    name: 'batch-seed-preview-only',
    async complete(): Promise<AICompletionResponse> {
      throw new Error('buildPrompt never calls the provider');
    },
    supportsVision: () => false,
    async isAvailable() {
      return false;
    },
  };
  const scribe = new ScribeAgent({
    dbClient: client,
    provider: unusedProvider,
    model,
  });

  const items: { key: string; request: AICompletionRequest }[] = [];
  let emptyCount = 0;
  let buildErrorCount = 0;
  let alreadyCachedCount = 0;

  for (const eventId of eventIds) {
    let built: Awaited<ReturnType<typeof scribe.buildPrompt>>;
    try {
      built = await scribe.buildPrompt(eventId, familyId);
    } catch (err) {
      buildErrorCount++;
      console.log(
        `  skipping ${eventId}: failed to build prompt -- ${err instanceof Error ? err.message : err}`,
      );
      continue;
    }
    if (built.empty) {
      emptyCount++;
      continue;
    }
    const request = buildScribeCompletionRequest(model, built);
    const key = hashCompletionRequest(request);
    if (store.get(key)) {
      alreadyCachedCount++;
      continue;
    }
    items.push({ key, request });
  }

  console.log(
    `${items.length} to submit (${emptyCount} empty, ${buildErrorCount} failed to build, ` +
      `${alreadyCachedCount} already cached).`,
  );
  if (items.length === 0) {
    console.log('Nothing new to submit.');
    return;
  }

  const results = await submitAnthropicBatchAndWait(
    anthropicClient,
    model,
    items,
    {
      onProgress: (counts) =>
        console.log(
          `  batch progress: ${counts.succeeded} succeeded, ${counts.errored} errored, ` +
            `${counts.canceled} canceled, ${counts.expired} expired, ${counts.processing} still processing`,
        ),
    },
  );

  const byKey = new Map(items.map((item) => [item.key, item.request]));
  let succeeded = 0;
  let unusable = 0;
  for (const result of results) {
    const request = byKey.get(result.key);
    if (!request) continue; // unreachable -- results() is keyed off items we just submitted
    if (result.response) {
      store.set(result.key, request, result.response);
      succeeded++;
    } else {
      unusable++;
      console.log(
        `  batch item ${result.key} did not produce a response: ${result.error}`,
      );
    }
  }
  console.log(
    `Batch seeding done: ${succeeded} cached, ${unusable} left uncached (will call live when processed).`,
  );
}

export async function runProcess(options: ProcessOptions): Promise<void> {
  if (options.responseReplayBatch && !options.familyId) {
    throw new Error('--response-replay-batch requires --family-id=<uuid>.');
  }
  const stages = parseStages(options.stages);
  if (options.responseReplayBatch && !stages.has('scribe')) {
    throw new Error(
      '--response-replay-batch conflicts with a --stages list that omits scribe: batch-seeding submits Scribe prompts specifically.',
    );
  }
  if (
    options.noRecord &&
    (options.responseReplay || options.responseReplayBatch)
  ) {
    throw new Error(
      '--no-record conflicts with --response-replay/--response-replay-batch: replaying a stored response requires recording to be enabled.',
    );
  }
  if (options.noRecord && options.responseReplayDb) {
    throw new Error(
      '--no-record conflicts with --response-replay-db: there is no store to write to. Remove one.',
    );
  }
  if (options.eventIds.length > 0 && !options.familyId) {
    throw new Error('--event-id requires --family-id=<uuid>.');
  }
  if (
    options.limit !== undefined &&
    (!Number.isInteger(options.limit) || options.limit < 1)
  ) {
    throw new Error(
      `--limit must be a positive integer, got ${options.limit}.`,
    );
  }
  const intentFilter = parseIntentFilter(options.intent);
  if (intentFilter && options.eventIds.length > 0) {
    throw new Error(
      '--intent has no effect with --event-id, which processes the given ids directly rather than claiming rows via the queue selector.',
    );
  }

  const client = createLiveDbClient('Queue process', options.allowRemoteDb);

  if (options.dryRun) {
    let targets: { eventId: string; familyId: string }[];
    if (options.eventIds.length > 0) {
      targets = options.eventIds.map((eventId) => ({
        eventId,
        familyId: options.familyId as string,
      }));
    } else {
      let query = client
        .from('processing_queue')
        .select('conversation_event_id, family_id')
        .eq('status', 'queued')
        .order('queued_at', { ascending: true });
      if (options.familyId) query = query.eq('family_id', options.familyId);
      if (intentFilter) query = query.in('intent', intentFilter);
      const { data, error: queryError } = await query;
      if (queryError) {
        throw new Error(`Failed to list queued events: ${queryError.message}`);
      }
      targets = (data ?? []).map((r) => ({
        eventId: r['conversation_event_id'] as string,
        familyId: r['family_id'] as string,
      }));
    }
    if (options.limit !== undefined) targets = targets.slice(0, options.limit);

    console.log(
      `\n=== Dry run: would process ${targets.length} message(s)${options.familyId ? ` for family ${options.familyId}` : ' across every family with anything queued'}${intentFilter ? ` (intent: ${intentFilter.join(',')})` : ''} ===`,
    );
    console.log(`Stages: ${[...stages].join(', ')}\n`);
    for (const t of targets.slice(0, 20)) {
      console.log(`  ${t.familyId}  ${t.eventId}`);
    }
    if (targets.length > 20) {
      console.log(`  ...and ${targets.length - 20} more`);
    }
    console.log(
      '\nNo provider calls made, queue untouched, no run log written.',
    );
    return;
  }

  const responseReplayDb = options.noRecord
    ? undefined
    : (options.responseReplayDb ??
      path.join(
        import.meta.dir,
        '..',
        '..',
        '..',
        '..',
        'tmp',
        'llm-response-replay.db',
      ));
  const replayMode = options.responseReplay || options.responseReplayBatch;

  const startedAt = Date.now();

  const perFamily = new Map<string, { processed: number; failed: number }>();
  let processed = 0;
  let failed = 0;
  let error: string | undefined;
  let scribeCaching: CachingProvider | undefined;
  let internCaching: CachingProvider | undefined;

  try {
    const anthropicApiKey = process.env['ANTHROPIC_API_KEY'];
    if (!anthropicApiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY not set -- Intern and Scribe both need a live provider to process.',
      );
    }

    console.log(
      `\n=== Processing ${options.familyId ? `family ${options.familyId}'s` : 'the'} queue (stages: ${[...stages].join(', ')}${intentFilter ? `, intent: ${intentFilter.join(',')}` : ''}) ===\n`,
    );
    if (!stages.has('scribe')) {
      console.log(
        'No Scribe stage requested: this never costs a Scribe call. Per-family counts below are expected to stay at 0.\n',
      );
    }
    const aiConfig = loadAIConfig(
      process.env as Record<string, string | undefined>,
    );
    const anthropicClient = new Anthropic({ apiKey: anthropicApiKey });
    const aiFactory = createAIProviderFactory(aiConfig, anthropicClient);
    const scribeModel =
      options.modelOverride ?? aiFactory.getModelForAgent('scribe');
    const internModel =
      options.internModelOverride ?? aiFactory.getModelForAgent('intern');

    const wantsIntern =
      stages.has('router') || stages.has('filter') || stages.has('imageLinker');
    let scribeProvider: AIProvider | undefined = stages.has('scribe')
      ? aiFactory.getProviderForAgent('scribe')
      : undefined;
    let internProvider: AIProvider | undefined = wantsIntern
      ? aiFactory.getProviderForAgent('intern')
      : undefined;
    if (responseReplayDb) {
      const store = new SqliteDevResponseCacheStore(responseReplayDb);
      if (options.responseReplayBatch) {
        // familyId presence already validated above.
        await seedResponseReplayFromBatch(
          client,
          options.familyId as string,
          scribeModel,
          anthropicClient,
          store,
        );
      }
      const mode = replayMode ? 'replay' : 'record-only';
      if (scribeProvider) {
        scribeCaching = new CachingProvider(scribeProvider, store, { mode });
        scribeProvider = scribeCaching;
      }
      if (internProvider) {
        internCaching = new CachingProvider(internProvider, store, { mode });
        internProvider = internCaching;
      }
      console.log(
        replayMode
          ? `--response-replay: substituting recorded responses via ${responseReplayDb}`
          : `Recording responses to ${responseReplayDb} (not substituting -- pass --response-replay to reuse them next time).`,
      );
    }

    const providers: { intern?: AIProvider; scribe?: AIProvider } = {};
    if (internProvider) providers.intern = internProvider;
    if (scribeProvider) providers.scribe = scribeProvider;

    const processor = buildMessagePipeline({
      dbClient: client,
      stages,
      providers,
      models: { intern: internModel, scribe: scribeModel },
    });

    const queueRepo = new ProcessingQueueRepository(client);
    let loopError: string | undefined;
    let attempted = 0;

    const runOne = async (
      eventId: string,
      familyId: string,
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        return await processor.process(eventId, familyId);
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    };

    const tallyResult = (
      familyId: string,
      itemResult: { success: boolean; error?: string },
      eventId: string,
    ): void => {
      const tally = perFamily.get(familyId) ?? { processed: 0, failed: 0 };
      if (itemResult.success) {
        processed++;
        tally.processed++;
      } else {
        failed++;
        tally.failed++;
        console.log(`  failed: ${eventId} -- ${itemResult.error}`);
      }
      perFamily.set(familyId, tally);
      attempted++;
      if (processed % 25 === 0 && processed > 0) {
        console.log(`  ...${processed} processed so far`);
      }
    };

    // Everything in this loop besides processor.process() itself (dequeue,
    // complete/fail, counting) can also throw -- e.g. a dropped DB
    // connection. Don't lose the tallies already accumulated if that
    // happens partway through; report as much as was actually done instead.
    try {
      if (options.eventIds.length > 0) {
        console.log(
          `--event-id: processing ${options.eventIds.length} given event(s) directly (any live queue row for each still gets completed/failed).`,
        );
        const familyId = options.familyId as string;
        const ids =
          options.limit !== undefined
            ? options.eventIds.slice(0, options.limit)
            : options.eventIds;
        for (const eventId of ids) {
          // A given event may still have a live queue row (queued, or a
          // stale processing row from a crashed worker) -- if so, this
          // needs to complete/fail it exactly like the normal loop does.
          // Leaving it untouched would mean a later `sbm process` run could
          // dequeue and process the same event again, and Scribe/Registrar
          // are not idempotent on a repeat pass (claims are never
          // deduplicated, only entities are) -- a real duplicate-data risk,
          // not just untidy bookkeeping. An event with no queue row at all
          // (never enqueued, or already completed by an earlier run) has
          // nothing to update; only that case is genuinely a no-op on the
          // queue.
          const queueItem = await queueRepo.findByEventId(familyId, eventId);
          // Claim it as 'processing' (when 'queued' or dead-lettered
          // 'error') before running it directly, so it counts toward the
          // per-family in-flight check `dequeueAny` relies on -- otherwise a
          // concurrent worker (the live poller, or another `sbm process`)
          // could claim and process this same event at the same time, which
          // -- per the comment above -- is a real duplicate-data risk, not
          // just untidy bookkeeping. A row already 'processing' means some
          // other worker owns it right now; only settle (complete/fail) a
          // row this invocation actually claimed, so it never clobbers that
          // worker's in-flight row out from under it.
          const claimed =
            !!queueItem &&
            (queueItem.status === 'queued' || queueItem.status === 'error');
          if (claimed) {
            await queueRepo.markProcessing(
              familyId,
              queueItem.id,
              'cli-process-event-id',
              ['queued', 'error'],
            );
          } else if (queueItem && queueItem.status === 'processing') {
            // Some other worker (the live poller, or a concurrent
            // `sbm process` invocation) owns this row right now -- running
            // it here too would be exactly the concurrent duplicate-data
            // risk the comment above describes. Skip it instead of
            // processing alongside that worker; it'll settle its own row.
            tallyResult(
              familyId,
              {
                success: false,
                error:
                  "queue row already 'processing' (owned by another worker)",
              },
              eventId,
            );
            continue;
          }
          const itemResult = await runOne(eventId, familyId);
          if (claimed && queueItem) {
            if (itemResult.success) {
              await queueRepo.complete(familyId, queueItem.id);
            } else {
              await queueRepo.fail(
                familyId,
                queueItem.id,
                itemResult.error || 'Unknown error',
                3,
              );
            }
          }
          tallyResult(familyId, itemResult, eventId);
        }
      } else {
        for (;;) {
          if (options.limit !== undefined && attempted >= options.limit) {
            console.log(`\nReached --limit=${options.limit}; stopping.`);
            break;
          }
          const item = await queueRepo.dequeueAny(
            'cli-process-worker',
            300_000,
            options.familyId,
            intentFilter,
          );
          if (!item) break;

          const itemResult = await runOne(
            item.conversationEventId,
            item.familyId,
          );
          if (itemResult.success) {
            await queueRepo.complete(item.familyId, item.id);
          } else {
            await queueRepo.fail(
              item.familyId,
              item.id,
              itemResult.error || 'Unknown error',
              3,
            );
          }
          tallyResult(item.familyId, itemResult, item.conversationEventId);
        }
      }
    } catch (err) {
      loopError = err instanceof Error ? err.message : String(err);
      console.log(`\nProcess loop stopped early: ${loopError}`);
    }
    console.log(`\nDone. Processed ${processed}, failed ${failed}.`);
    if (scribeCaching) {
      const { hits, misses } = scribeCaching.getStats();
      console.log(
        `--response-replay (scribe): ${hits} substituted, ${misses} called live and recorded.`,
      );
    }
    if (internCaching) {
      const { hits, misses } = internCaching.getStats();
      console.log(
        `--response-replay (intern): ${hits} substituted, ${misses} called live and recorded.`,
      );
    }
    error = loopError;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    const families: ProcessFamilyResult[] = [];
    for (const [familyId, tally] of perFamily) {
      const counts = await getFamilyCounts(client, familyId);
      families.push({ familyId, ...tally, ...counts });
    }

    appendRunLog(RUN_LOG_PATH, {
      mode: 'process',
      durationMs: Date.now() - startedAt,
      completed: error === undefined,
      error,
      processed,
      failed,
      families,
      familyId: options.familyId,
      stages: [...stages],
      intentFilter,
      limit: options.limit,
      eventIds: options.eventIds.length > 0 ? options.eventIds : undefined,
      responseRecording: responseReplayDb
        ? {
            enabled: true,
            replay: replayMode,
            dbPath: responseReplayDb,
            scribe: scribeCaching?.getStats(),
            intern: internCaching?.getStats(),
          }
        : { enabled: false },
    });

    console.log(
      `\n=== Run summary (logged to ${path.relative(process.cwd(), RUN_LOG_PATH)}) ===\n`,
    );
    for (const f of families) {
      console.log(
        `  ${f.familyId}: ${f.processed} processed, ${f.failed} failed, ${f.people} people, ` +
          `${f.claims} claims, ${f.stories} stories, ${f.places} places, ${f.conflicts} conflicts`,
      );
    }
  }

  // The inner catch above deliberately doesn't rethrow so the run log/
  // summary above still get written on a mid-run failure -- but citty's
  // runMain only sets a non-zero exit code when the command handler throws,
  // so without this, a partial/failed run (e.g. a dropped DB connection)
  // would otherwise report success (exit 0) to any script chaining
  // `sbm import && sbm process`.
  if (error !== undefined) {
    throw new Error(error);
  }
}
