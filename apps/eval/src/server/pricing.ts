import type { RecordedCall } from './recording-provider';

/**
 * Per-million-token pricing for models this tool is likely to run
 * (eval-tool-v2-plan.md item #2). Deliberately small and explicit rather than
 * pattern-matched — an unrecognised model id (typo, a retired model, a new
 * release not yet added here) must fall back to "unknown", never a silently
 * wrong number.
 */
interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

const PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-5-20250929': { inputPer1M: 3, outputPer1M: 15 },
  'claude-sonnet-4-5': { inputPer1M: 3, outputPer1M: 15 },
  'claude-sonnet-4-6': { inputPer1M: 3, outputPer1M: 15 },
  'claude-sonnet-5': { inputPer1M: 2, outputPer1M: 10 },
  'claude-haiku-4-5-20251001': { inputPer1M: 1, outputPer1M: 5 },
  'claude-haiku-4-5': { inputPer1M: 1, outputPer1M: 5 },
  'claude-opus-4-6': { inputPer1M: 5, outputPer1M: 25 },
  'claude-opus-4-7': { inputPer1M: 5, outputPer1M: 25 },
  'claude-opus-4-8': { inputPer1M: 5, outputPer1M: 25 },
  'claude-opus-5': { inputPer1M: 5, outputPer1M: 25 },
};

export interface CostEstimate {
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
}

/**
 * Sums a run's recorded LLM calls into a dollar estimate for `model`, or
 * `null` when the model isn't in the table — the caller renders that as "—",
 * never as a wrong number (decision in the plan item).
 *
 * Uses `usage.inputTokens`/`outputTokens` at face value. Scribe enables
 * prompt caching (`enablePromptCache: true`), and cached reads cost far less
 * than a fresh input token — but `AICompletionResponse.usage` (checked
 * against `libs/ai-provider`'s Anthropic response mapping) does not expose
 * cache-read/cache-write counts, only combined `inputTokens`. So this is
 * always an upper-bound "uncached estimate", never a precise cost; the UI
 * must label it that way rather than implying precision the data can't
 * support.
 */
export function estimateCost(
  model: string,
  calls: RecordedCall[],
): CostEstimate | null {
  const pricing = PRICING[model];
  if (!pricing) return null;

  let inputTokens = 0;
  let outputTokens = 0;
  for (const call of calls) {
    if (!call.response) continue;
    inputTokens += call.response.usage.inputTokens;
    outputTokens += call.response.usage.outputTokens;
  }

  const inputCostUsd = (inputTokens / 1_000_000) * pricing.inputPer1M;
  const outputCostUsd = (outputTokens / 1_000_000) * pricing.outputPer1M;
  return {
    inputCostUsd,
    outputCostUsd,
    totalCostUsd: inputCostUsd + outputCostUsd,
  };
}
