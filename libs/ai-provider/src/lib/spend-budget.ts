/**
 * Daily spend budget
 *
 * A process-local, in-memory cap on total tokens used per UTC day. Fed by
 * the dollar cost of each call (`BudgetedProvider` prices the usage providers
 * already return). Not persisted: a restart resets the counter, so the bound is "per
 * process per day", which matches the single-instance deployment.
 */

export interface SpendBudgetOptions {
  /** Max estimated US dollars per UTC day. Must be a positive finite number. */
  dailyLimitUsd: number;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Fired once per UTC day, the first time the budget is found exhausted. */
  onExhausted?: (state: {
    usedUsd: number;
    limitUsd: number;
    day: string;
  }) => void;
}

export class SpendBudget {
  private readonly dailyLimitUsd: number;
  private readonly now: () => Date;
  private readonly onExhausted?: SpendBudgetOptions['onExhausted'];
  private day: string;
  private used = 0;
  private noticeSentForDay?: string;

  constructor(options: SpendBudgetOptions) {
    if (!Number.isFinite(options.dailyLimitUsd) || options.dailyLimitUsd <= 0) {
      throw new Error('SpendBudget dailyLimitUsd must be a positive number');
    }
    this.dailyLimitUsd = options.dailyLimitUsd;
    this.now = options.now ?? (() => new Date());
    this.onExhausted = options.onExhausted;
    this.day = this.currentDay();
  }

  /** Add a call's estimated cost (USD) to today's total. */
  record(usd: number): void {
    this.rollover();
    if (Number.isFinite(usd) && usd > 0) this.used += usd;
  }

  /** True once today's usage has reached the limit. Notifies once per day. */
  isExhausted(): boolean {
    this.rollover();
    const exhausted = this.used >= this.dailyLimitUsd;
    if (exhausted && this.noticeSentForDay !== this.day) {
      this.noticeSentForDay = this.day;
      this.onExhausted?.({
        usedUsd: this.used,
        limitUsd: this.dailyLimitUsd,
        day: this.day,
      });
    }
    return exhausted;
  }

  getUsage(): { usedUsd: number; limitUsd: number; day: string } {
    this.rollover();
    return {
      usedUsd: this.used,
      limitUsd: this.dailyLimitUsd,
      day: this.day,
    };
  }

  private currentDay(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private rollover(): void {
    const today = this.currentDay();
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
    }
  }
}
