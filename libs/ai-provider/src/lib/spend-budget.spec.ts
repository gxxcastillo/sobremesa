import { describe, it, expect, vi } from 'vitest';
import { SpendBudget } from './spend-budget';
import { estimateCostUsd } from './pricing';
import { BudgetedProvider, BudgetExhaustedError } from './providers/budgeted';
import type { AIProvider } from './provider.interface';

function clock(iso: string) {
  let t = new Date(iso);
  return {
    now: () => t,
    set: (next: string) => {
      t = new Date(next);
    },
  };
}

/** A call that costs exactly $3 at Sonnet rates (1M input tokens). */
const SONNET_1M_IN = {
  inputTokens: 1_000_000,
  outputTokens: 0,
  totalTokens: 1_000_000,
};

function fakeProvider(
  model: string,
  usage = SONNET_1M_IN,
): AIProvider & { complete: any } {
  return {
    name: 'anthropic',
    complete: vi.fn().mockResolvedValue({ content: 'ok', model, usage }),
    supportsVision: () => false,
    isAvailable: async () => true,
  };
}

describe('SpendBudget', () => {
  it('rejects a non-positive limit', () => {
    expect(() => new SpendBudget({ dailyLimitUsd: 0 })).toThrow();
    expect(() => new SpendBudget({ dailyLimitUsd: NaN })).toThrow();
  });

  it('counts dollars and reports exhaustion at the limit', () => {
    const b = new SpendBudget({ dailyLimitUsd: 1 });
    b.record(0.6);
    expect(b.isExhausted()).toBe(false);
    b.record(0.4);
    expect(b.isExhausted()).toBe(true);
  });

  it('resets at the UTC day boundary', () => {
    const c = clock('2026-10-03T23:59:00Z');
    const b = new SpendBudget({ dailyLimitUsd: 10, now: c.now });
    b.record(10);
    expect(b.isExhausted()).toBe(true);
    c.set('2026-10-04T00:00:01Z');
    expect(b.isExhausted()).toBe(false);
    expect(b.getUsage()).toEqual({
      usedUsd: 0,
      limitUsd: 10,
      day: '2026-10-04',
    });
  });

  it('notifies once per day, again after rollover', () => {
    const c = clock('2026-10-03T12:00:00Z');
    const onExhausted = vi.fn();
    const b = new SpendBudget({ dailyLimitUsd: 5, now: c.now, onExhausted });
    b.record(5);
    b.isExhausted();
    b.isExhausted();
    expect(onExhausted).toHaveBeenCalledTimes(1);
    c.set('2026-10-04T12:00:00Z');
    b.record(5);
    b.isExhausted();
    expect(onExhausted).toHaveBeenCalledTimes(2);
  });

  it('ignores invalid amounts', () => {
    const b = new SpendBudget({ dailyLimitUsd: 10 });
    b.record(NaN);
    b.record(-5);
    expect(b.getUsage().usedUsd).toBe(0);
  });
});

describe('estimateCostUsd', () => {
  it('prices input and output separately', () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      totalTokens: 2_000_000,
    };
    expect(estimateCostUsd('claude-sonnet-4-5', usage, 'free')).toBeCloseTo(18);
    expect(estimateCostUsd('claude-haiku-4-5', usage, 'free')).toBeCloseTo(6);
  });

  it('prices cache reads at 0.1x and writes at 1.25x input', () => {
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
    };
    expect(estimateCostUsd('claude-sonnet-4-5', usage, 'free')).toBeCloseTo(
      0.3 + 3.75,
    );
  });

  it('charges unknown models the most expensive rate or nothing', () => {
    expect(
      estimateCostUsd('mystery', SONNET_1M_IN, 'conservative'),
    ).toBeCloseTo(5);
    expect(estimateCostUsd('llama3.2:latest', SONNET_1M_IN, 'free')).toBe(0);
  });
});

describe('BudgetedProvider', () => {
  it('records the priced cost of each call', async () => {
    const b = new SpendBudget({ dailyLimitUsd: 100 });
    const p = new BudgetedProvider(
      fakeProvider('claude-sonnet-4-5'),
      b,
      'conservative',
    );
    await p.complete({} as any);
    await p.complete({} as any);
    expect(b.getUsage().usedUsd).toBeCloseTo(6);
  });

  it('refuses calls without hitting the inner provider once exhausted', async () => {
    const b = new SpendBudget({ dailyLimitUsd: 3 });
    const inner = fakeProvider('claude-sonnet-4-5');
    const p = new BudgetedProvider(inner, b, 'conservative');
    await p.complete({} as any);
    await expect(p.complete({} as any)).rejects.toBeInstanceOf(
      BudgetExhaustedError,
    );
    expect(inner.complete).toHaveBeenCalledTimes(1);
  });

  it('does not charge local models', async () => {
    const b = new SpendBudget({ dailyLimitUsd: 1 });
    const p = new BudgetedProvider(fakeProvider('llama3.2:latest'), b, 'free');
    await p.complete({} as any);
    expect(b.getUsage().usedUsd).toBe(0);
  });
});
