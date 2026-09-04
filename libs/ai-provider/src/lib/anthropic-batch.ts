/**
 * Anthropic Batch API support for seeding the dev response cache
 * (`CachingProvider` / `SqliteDevResponseCacheStore`, see `providers/caching.ts`)
 * at half the per-token price and without one round trip per message.
 *
 * Deliberately not part of the `AIProvider` interface: batch submission is
 * fundamentally asynchronous (submit many requests, poll until Anthropic
 * finishes -- their own SLA is "up to 24 hours", though usually much
 * faster -- then collect results keyed by `custom_id`), unlike `complete()`'s
 * one-request-in-one-response-out contract. This only ever seeds the cache
 * store directly; it never substitutes for a live call itself.
 */
import { createLogger } from '@sobremesa/shared-utils';
import {
  buildAnthropicRequestParams,
  mapAnthropicResponse,
  STRUCTURED_OUTPUTS_BETA,
} from './providers/anthropic';
import type { AICompletionRequest, AICompletionResponse } from './types';

const logger = createLogger({ name: 'anthropic-batch' });

/**
 * Anthropic SDK client type. Using unknown-ish `any` to avoid version
 * mismatches, matching `AnthropicProvider`'s own client typing -- the actual
 * client is injected by the caller.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnthropicClient = any;

export interface BatchSeedItem {
  /** Cache key (`hashCompletionRequest(request)`); doubles as the batch's `custom_id`. */
  key: string;
  request: AICompletionRequest;
}

export interface BatchSeedResult {
  key: string;
  /** Set on a successful result. */
  response?: AICompletionResponse;
  /** Set instead of `response` for an errored/canceled/expired/missing result. */
  error?: string;
}

export interface BatchRequestCounts {
  processing: number;
  succeeded: number;
  errored: number;
  canceled: number;
  expired: number;
}

export interface SubmitAnthropicBatchOptions {
  /** How often to poll for completion, in ms. Default 30s. */
  pollIntervalMs?: number;
  /** Called after each poll with the current per-status tally. */
  onProgress?: (counts: BatchRequestCounts) => void;
}

/**
 * Submits every item as one Anthropic Message Batch, polls until it ends,
 * and returns one `BatchSeedResult` per item (order matches `items`, not
 * the order results come back in -- Anthropic doesn't guarantee that
 * either). Never throws for a per-item failure: an errored, canceled,
 * expired, or unexpectedly missing result is reported via `error` so the
 * caller can leave that one item to fall through to a live call on the next
 * drain instead of losing the whole run over one bad request.
 */
export async function submitAnthropicBatchAndWait(
  client: AnthropicClient,
  defaultModel: string,
  items: BatchSeedItem[],
  options: SubmitAnthropicBatchOptions = {},
): Promise<BatchSeedResult[]> {
  if (items.length === 0) return [];

  // The Anthropic Batch API requires `custom_id` to be unique within a
  // batch, and we use each item's cache key as its `custom_id`. Two items
  // with identical requests (e.g. duplicate cache-seed entries) hash to the
  // same key, so dedupe by key before building the request list -- the
  // final `items.map` below looks results back up by key, so every item
  // sharing a key still gets that key's result.
  const uniqueItems = [
    ...new Map(items.map((item) => [item.key, item])).values(),
  ];

  const built = uniqueItems.map((item) => ({
    item,
    build: buildAnthropicRequestParams(item.request, defaultModel),
  }));

  // `betas` is a Batch-level field on `BatchCreateParams`, not a per-request
  // one -- `buildAnthropicRequestParams` sets it for the single-call beta
  // endpoint, so strip it back out of each request's own params here and
  // apply it once for the whole batch if any item needs it.
  const needsBeta = built.some(({ build }) => build.useBeta);
  const requests = built.map(({ item, build }) => {
    const params = { ...build.params } as Record<string, unknown>;
    delete params['betas'];
    return { custom_id: item.key, params };
  });

  logger.info(
    { count: requests.length, needsBeta },
    'Submitting Anthropic message batch',
  );
  const created = await client.beta.messages.batches.create({
    requests,
    ...(needsBeta ? { betas: [STRUCTURED_OUTPUTS_BETA] } : {}),
  });

  const pollIntervalMs = options.pollIntervalMs ?? 30_000;
  let batch = created;
  while (batch.processing_status !== 'ended') {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    batch = await client.beta.messages.batches.retrieve(created.id);
    options.onProgress?.(batch.request_counts);
    logger.info(
      { batchId: created.id, ...batch.request_counts },
      'Batch still processing',
    );
  }
  logger.info({ batchId: created.id, ...batch.request_counts }, 'Batch ended');

  const resultsByKey = new Map<string, BatchSeedResult>();
  const stream = await client.beta.messages.batches.results(created.id);
  for await (const line of stream as AsyncIterable<{
    custom_id: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result: { type: string; message?: any; error?: unknown };
  }>) {
    const { custom_id, result } = line;
    if (result.type === 'succeeded') {
      // mapAnthropicResponse throws if the message has no text content
      // (e.g. a refusal or tool-only response). Catch it here so one bad
      // item is reported via `error` like any other per-item failure,
      // rather than rejecting the whole batch and losing every other
      // already-resolved result.
      try {
        resultsByKey.set(custom_id, {
          key: custom_id,
          response: mapAnthropicResponse(result.message),
        });
      } catch (err) {
        resultsByKey.set(custom_id, {
          key: custom_id,
          error: `unmappable response: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } else {
      resultsByKey.set(custom_id, {
        key: custom_id,
        error:
          result.type === 'errored'
            ? `errored: ${JSON.stringify(result.error)}`
            : result.type,
      });
    }
  }

  return items.map(
    (item) =>
      resultsByKey.get(item.key) ?? {
        key: item.key,
        error: 'missing from batch results',
      },
  );
}
