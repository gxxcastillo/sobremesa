import { describe, expect, it } from 'vitest';
import { buildReport, buildSuiteReport, scoreScenario } from './scorer';
import type {
  EvalReport,
  ScenarioRunResult,
  ScribeEvalScenario,
} from './scenario';
import type { ScribeDomainModel } from '@sobremesa/shared-types';

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
    groundingFailureRate: 0,
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
      grounding: { totalClaims: 0, grounded: 0, contextBleed: 0, unmatched: 0 },
    })),
  };
}

function domainModel(claims: ScribeDomainModel['claims']): ScribeDomainModel {
  return {
    conversationEventId: 'event-1',
    familyId: 'family-1',
    processedAt: new Date('2026-01-01T00:00:00.000Z'),
    people: [],
    places: [],
    events: [],
    relationships: [],
    claims,
    imageReferences: [],
  };
}

describe('scoreScenario — grounding filter (provenance #3)', () => {
  const scenario: ScribeEvalScenario = {
    id: 'grounding-test',
    description: 'grounding filter mirrors the Registrar',
    senders: {
      ana: { id: 'ana', displayName: 'Ana' },
    },
    initialContext: [
      { sender: 'ana', text: 'Rosa moved to Guadalajara in 1965.' },
    ],
    messages: [
      { sender: 'ana', text: 'Grandpa Ernesto was born in Oaxaca in 1943.' },
    ],
    golden: {
      requiredClaims: [{ subject: 'Ernesto' }],
      forbidden: { claimSubjects: ['Rosa'] },
    },
  };

  const groundedClaim = {
    claimType: 'date',
    subject: "Ernesto's birth",
    claimValue: '1943',
    evidence: 'born in Oaxaca in 1943',
    confidence: 'high' as const,
    claimedBySource: 'direct' as const,
  };

  it('drops context-bleed claims before scoring, so a bled forbidden subject does not hard-fail', () => {
    const run: ScenarioRunResult = {
      scenario,
      outputs: [
        domainModel([
          groundedClaim,
          {
            claimType: 'location',
            subject: "Rosa's move",
            claimValue: 'Guadalajara',
            // Verbatim from the context message only: definite bleed.
            evidence: 'Rosa moved to Guadalajara in 1965',
            confidence: 'medium',
            claimedBySource: 'direct',
          },
        ]),
      ],
    };

    const score = scoreScenario(run, 0.8);

    expect(score.grounding).toEqual({
      totalClaims: 2,
      grounded: 1,
      contextBleed: 1,
      unmatched: 0,
    });
    expect(score.hardFailed).toBe(false);
    expect(score.forbiddenHits).toEqual([]);
  });

  it('keeps unmatched-evidence claims in scoring (the pipeline persists them, flagged)', () => {
    const run: ScenarioRunResult = {
      scenario,
      outputs: [
        domainModel([
          groundedClaim,
          {
            claimType: 'detail',
            subject: 'Rosa',
            claimValue: 'loved mangoes',
            evidence: 'she loved mangoes', // matches nothing
            confidence: 'medium',
            claimedBySource: 'direct',
          },
        ]),
      ],
    };

    const score = scoreScenario(run, 0.8);

    expect(score.grounding).toEqual({
      totalClaims: 2,
      grounded: 1,
      contextBleed: 0,
      unmatched: 1,
    });
    // The unmatched claim survives into scoring and trips the forbidden
    // subject — exactly what the pipeline would persist.
    expect(score.hardFailed).toBe(true);
  });

  it('grounds against the same bounded window the model saw, not full history', () => {
    const windowedScenario: ScribeEvalScenario = {
      ...scenario,
      contextWindow: 1,
      initialContext: [
        // Outside the 1-message window by the time the scored message runs.
        { sender: 'ana', text: 'Rosa moved to Guadalajara in 1965.' },
        { sender: 'ana', text: 'We should plan the reunion soon.' },
      ],
    };
    const run: ScenarioRunResult = {
      scenario: windowedScenario,
      outputs: [
        domainModel([
          {
            claimType: 'location',
            subject: "Rosa's move",
            claimValue: 'Guadalajara',
            // Matches only the out-of-window message: the model never saw it,
            // and neither does the pipeline — unmatched (kept), not bleed.
            evidence: 'Rosa moved to Guadalajara in 1965',
            confidence: 'medium',
            claimedBySource: 'direct',
          },
        ]),
      ],
    };

    const score = scoreScenario(run, 0.8);

    expect(score.grounding).toEqual({
      totalClaims: 1,
      grounded: 0,
      contextBleed: 0,
      unmatched: 1,
    });
  });

  it('fails the report when the grounding-failure rate exceeds the gate, regardless of score', () => {
    const run: ScenarioRunResult = {
      scenario,
      outputs: [
        domainModel([
          groundedClaim,
          ...Array.from({ length: 4 }, (_, i) => ({
            claimType: 'detail',
            subject: `Rosa bleed ${i}`,
            claimValue: 'Guadalajara',
            evidence: 'Rosa moved to Guadalajara in 1965',
            confidence: 'medium' as const,
            claimedBySource: 'direct' as const,
          })),
        ]),
      ],
    };

    const report = buildReport({
      results: [run],
      provider: 'anthropic',
      model: 'test-model',
      threshold: 0.8,
    });

    // 4 of 5 claims bleed: the score is unaffected (bleed never persists),
    // but the suite must not PASS through a wholesale re-extraction regression.
    expect(report.groundingFailureRate).toBeCloseTo(0.8);
    expect(report.scenarioScores[0].hardFailed).toBe(false);
    expect(report.passed).toBe(false);
  });
});

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
