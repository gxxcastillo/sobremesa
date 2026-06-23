/**
 * Cost Estimator for WhatsApp Import
 *
 * Estimates token counts and costs for Anthropic Batch API processing.
 */

import type { ParsedMessage, CostEstimate } from '@sobremesa/shared-types';

// Batch API pricing (50% discount from standard)
const BATCH_INPUT_PRICE_PER_MILLION = 1.5; // Claude 3.5 Sonnet / Claude Sonnet 4
const BATCH_OUTPUT_PRICE_PER_MILLION = 7.5;

// Token estimation constants
const SYSTEM_PROMPT_TOKENS = 2000; // Fixed Scribe prompt size
const AVG_CONTEXT_TOKENS = 500; // Previous messages context window
const OUTPUT_RATIO = 0.2; // Output is typically ~20% of input
const CHARS_PER_TOKEN = 4; // Rough estimate for English/Spanish text

/**
 * Estimate token count for a message.
 */
function estimateMessageTokens(message: ParsedMessage): number {
  // Base tokens for message structure
  let tokens = 50;

  // Content tokens (rough estimate)
  if (message.content) {
    tokens += Math.ceil(message.content.length / CHARS_PER_TOKEN);
  }

  // Metadata tokens (sender, timestamp, etc.)
  tokens += 30;

  return tokens;
}

/**
 * Estimate the total cost of importing messages via Batch API.
 */
export function estimateImportCost(messages: ParsedMessage[]): CostEstimate {
  let totalInputTokens = 0;

  for (const message of messages) {
    // Each message gets its own Scribe call with context
    totalInputTokens += SYSTEM_PROMPT_TOKENS;
    totalInputTokens += estimateMessageTokens(message);
    totalInputTokens += AVG_CONTEXT_TOKENS;
  }

  // Estimate output tokens based on input ratio
  const outputTokens = Math.ceil(totalInputTokens * OUTPUT_RATIO);

  // Calculate costs (prices are per million tokens)
  const inputCost =
    (totalInputTokens / 1_000_000) * BATCH_INPUT_PRICE_PER_MILLION;
  const outputCost =
    (outputTokens / 1_000_000) * BATCH_OUTPUT_PRICE_PER_MILLION;
  const totalCost = inputCost + outputCost;

  // Standard API would cost 2x (no batch discount)
  const standardCost = totalCost * 2;
  const savings = standardCost - totalCost;

  return {
    inputTokens: totalInputTokens,
    outputTokens,
    inputCost: Math.round(inputCost * 100) / 100,
    outputCost: Math.round(outputCost * 100) / 100,
    totalCost: Math.round(totalCost * 100) / 100,
    standardCost: Math.round(standardCost * 100) / 100,
    savings: Math.round(savings * 100) / 100,
  };
}

/**
 * Format cost estimate for display.
 */
export function formatCostEstimate(estimate: CostEstimate): string {
  const lines = [
    '═══════════════════════════════════════════════════════════',
    'WhatsApp Import Cost Estimate',
    '═══════════════════════════════════════════════════════════',
    '',
    'Token Estimates:',
    `  Input tokens:      ${estimate.inputTokens.toLocaleString()}`,
    `  Output tokens:     ${estimate.outputTokens.toLocaleString()} (estimated)`,
    '',
    'Cost Estimate (Batch API with 50% discount):',
    `  Input:    $${estimate.inputCost.toFixed(2)}`,
    `  Output:   $${estimate.outputCost.toFixed(2)}`,
    `  ─────────────────`,
    `  Total:    $${estimate.totalCost.toFixed(2)}`,
    '',
    `Standard API would cost: $${estimate.standardCost.toFixed(2)} (you save $${estimate.savings.toFixed(2)})`,
    '═══════════════════════════════════════════════════════════',
  ];

  return lines.join('\n');
}

/**
 * Calculate number of batches needed for messages.
 * Batch API limit is 10,000 requests per batch.
 */
export function calculateBatchCount(messageCount: number): number {
  const BATCH_LIMIT = 10_000;
  return Math.ceil(messageCount / BATCH_LIMIT);
}
