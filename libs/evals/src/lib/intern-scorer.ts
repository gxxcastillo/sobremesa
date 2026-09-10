import type { InternScenarioRunResult } from './run-intern-scenario';
import type { ScribeEvalScenario } from './scenario';

export interface InternMismatch {
  messageIndex: number;
  field: 'action' | 'relevant' | 'language';
  expected: string | boolean;
  actual: string | boolean | undefined | null;
}

export interface InternScore {
  total: number;
  matched: number;
  accuracy: number;
  mismatches: InternMismatch[];
}

/** Score exact asserted Intern fields; unasserted/sparse fields do not count. */
export function scoreInternRun(
  result: InternScenarioRunResult,
  scenario: ScribeEvalScenario,
): InternScore {
  const mismatches: InternMismatch[] = [];
  let total = 0;
  let matched = 0;
  for (const [messageIndex, expected] of (
    scenario.internGolden ?? []
  ).entries()) {
    if (!expected) continue;
    const actual = result.decisions[messageIndex];
    for (const field of ['action', 'relevant', 'language'] as const) {
      if (expected[field] === undefined) continue;
      total++;
      if (actual?.[field] === expected[field]) matched++;
      else
        mismatches.push({
          messageIndex,
          field,
          expected: expected[field],
          actual: actual?.[field],
        });
    }
  }
  return {
    total,
    matched,
    accuracy: total === 0 ? 0 : matched / total,
    mismatches,
  };
}
