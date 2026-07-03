import { describe, expect, it } from 'vitest';
import { buildSuiteReport } from './scorer';
import type { EvalReport } from './scenario';

function report(
  provider: string,
  scenarioScores: Array<[string, number]>,
): EvalReport {
  return {
    generatedAt: new Date('2026-01-01T00:00:00.000Z'),
    provider,
    model: `${provider}-model`,
    threshold: 0.8,
    aggregateScore:
      scenarioScores.reduce((sum, [, score]) => sum + score, 0) /
      scenarioScores.length,
    aggregatePrecision: 1,
    aggregateRecall: 1,
    passed: true,
    scenarioScores: scenarioScores.map(([scenarioId, score]) => ({
      scenarioId,
      description: scenarioId,
      score,
      precision: 1,
      recall: 1,
      passed: true,
      hardFailed: false,
      categories: [],
      forbiddenHits: [],
    })),
  };
}

describe('buildSuiteReport', () => {
  it('computes Anthropic-minus-local capability gaps per scenario', () => {
    const suite = buildSuiteReport({
      reports: [
        report('anthropic', [
          ['a', 0.9],
          ['b', 0.8],
        ]),
        report('local', [
          ['a', 0.6],
          ['b', 0.75],
        ]),
      ],
      threshold: 0.8,
    });

    expect(suite.baselineProvider).toBe('anthropic');
    expect(suite.aggregateCapabilityGap).toBeCloseTo(0.175);
    expect(suite.capabilityGaps).toEqual([
      {
        scenarioId: 'a',
        baselineProvider: 'anthropic',
        candidateProvider: 'local',
        baselineScore: 0.9,
        candidateScore: 0.6,
        gap: 0.30000000000000004,
      },
      {
        scenarioId: 'b',
        baselineProvider: 'anthropic',
        candidateProvider: 'local',
        baselineScore: 0.8,
        candidateScore: 0.75,
        gap: 0.050000000000000044,
      },
    ]);
  });

  it('omits capability gaps for a single-provider run', () => {
    const suite = buildSuiteReport({
      reports: [report('anthropic', [['a', 0.9]])],
      threshold: 0.8,
    });

    expect(suite.capabilityGaps).toEqual([]);
    expect(suite.aggregateCapabilityGap).toBeUndefined();
  });
});
