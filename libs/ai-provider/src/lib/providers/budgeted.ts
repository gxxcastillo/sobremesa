/**
 * Budget-enforcing provider wrapper
 *
 * Hard backstop for the daily spend budget: refuses a call once the budget
 * is exhausted and records the estimated cost of every call that goes
 * through. The queue's pre-dequeue check (see `MessageQueue.setGate`) is the
 * primary guard that keeps items `queued`; this wrapper covers every other
 * call path (Historian, Facilitator, follow-ups) and calls already past the
 * gate. It works with any provider; callers choose which to wrap.
 */
import type { AIProvider } from '../provider.interface';
import type { AICompletionRequest, AICompletionResponse } from '../types';
import type { SpendBudget } from '../spend-budget';
import { estimateCostUsd, type UnknownModelPricing } from '../pricing';

export class BudgetExhaustedError extends Error {
  constructor() {
    super('Daily LLM spend budget exhausted');
    this.name = 'BudgetExhaustedError';
  }
}

export class BudgetedProvider implements AIProvider {
  readonly name: string;
  readonly listModels?: () => Promise<string[]>;

  /**
   * @param unknownModelPricing How to price a model missing from the pricing
   *   table: `'conservative'` for paid providers, `'free'` for local ones.
   */
  constructor(
    private readonly inner: AIProvider,
    private readonly budget: SpendBudget,
    private readonly unknownModelPricing: UnknownModelPricing,
  ) {
    this.name = inner.name;
    this.listModels = inner.listModels?.bind(inner);
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    if (this.budget.isExhausted()) throw new BudgetExhaustedError();
    const response = await this.inner.complete(request);
    this.budget.record(
      estimateCostUsd(response.model, response.usage, this.unknownModelPricing),
    );
    return response;
  }

  supportsVision(): boolean {
    return this.inner.supportsVision();
  }

  isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }
}
