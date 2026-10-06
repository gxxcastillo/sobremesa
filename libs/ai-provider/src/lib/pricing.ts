/**
 * Per-model pricing, used to meter spend (see `SpendBudget`).
 *
 * Deliberately small and explicit. A model missing from the table is priced
 * by `unknown`: `'conservative'` charges the most expensive rate here, so a
 * new or mistyped model id can only make the budget trip early, never late;
 * `'free'` charges $0, for local models.
 */
import type { AICompletionResponse } from './types';

interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

const SONNET: ModelPricing = { inputPer1M: 3, outputPer1M: 15 };
const HAIKU: ModelPricing = { inputPer1M: 1, outputPer1M: 5 };
const OPUS: ModelPricing = { inputPer1M: 5, outputPer1M: 25 };

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-5-20250929': SONNET,
  'claude-sonnet-4-5': SONNET,
  'claude-sonnet-4-6': SONNET,
  'claude-sonnet-5': { inputPer1M: 2, outputPer1M: 10 },
  'claude-haiku-4-5-20251001': HAIKU,
  'claude-haiku-4-5': HAIKU,
  'claude-opus-4-6': OPUS,
  'claude-opus-4-7': OPUS,
  'claude-opus-4-8': OPUS,
  'claude-opus-5': OPUS,
};

const CONSERVATIVE: ModelPricing = OPUS;

/** Cache reads bill at 0.1x input, 5-minute cache writes at 1.25x. */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

export type UnknownModelPricing = 'conservative' | 'free';

/** Estimated USD cost of one completion. */
export function estimateCostUsd(
  model: string,
  usage: AICompletionResponse['usage'],
  unknown: UnknownModelPricing,
): number {
  const price =
    MODEL_PRICING[model] ??
    (unknown === 'conservative' ? CONSERVATIVE : undefined);
  if (!price) return 0;

  const inputRate = price.inputPer1M / 1_000_000;
  return (
    usage.inputTokens * inputRate +
    (usage.cacheReadTokens ?? 0) * inputRate * CACHE_READ_MULTIPLIER +
    (usage.cacheCreationTokens ?? 0) * inputRate * CACHE_WRITE_MULTIPLIER +
    usage.outputTokens * (price.outputPer1M / 1_000_000)
  );
}
