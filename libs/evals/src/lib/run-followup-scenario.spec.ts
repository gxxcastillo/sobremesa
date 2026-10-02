import { describe, expect, it } from 'vitest';
import {
  facilitatorActivationScenarios,
  followupFormulationScenarios,
} from '../scenarios/followup-scenarios';
import {
  runFacilitatorActivationScenario,
  runFollowupFormulationScenario,
} from './run-followup-scenario';

describe('story-followups-plan.md #7: followup formulation scenarios', () => {
  for (const scenario of followupFormulationScenarios) {
    it(`${scenario.id} -- ${scenario.description}`, async () => {
      const result = await runFollowupFormulationScenario(scenario);

      expect(result.ask).toBe(scenario.expected.ask);
      if (scenario.expected.reasonIncludes) {
        expect(result.reason).toContain(scenario.expected.reasonIncludes);
      }
      if (scenario.expected.namesUsed) {
        expect(result.namesUsed).toEqual(scenario.expected.namesUsed);
      }
      if (scenario.expected.questionContains) {
        expect(result.question?.content).toContain(
          scenario.expected.questionContains,
        );
      }
    });
  }

  it('documents exactly one known limitation (relationship hallucination), not silently', () => {
    const limited = followupFormulationScenarios.filter(
      (s) => s.knownLimitation,
    );
    expect(limited.map((s) => s.id)).toEqual([
      'known-names-invented-relationship',
    ]);
  });
});

describe('story-followups-plan.md #7: facilitator activation scenarios', () => {
  for (const scenario of facilitatorActivationScenarios) {
    it(`${scenario.id} -- ${scenario.description}`, async () => {
      const run = await runFacilitatorActivationScenario(scenario);

      expect(run.result.success).toBe(scenario.expected.success);

      if (scenario.expected.sent) {
        expect(run.sentMessages).toHaveLength(1);
        if (scenario.expected.sentTextEquals !== undefined) {
          expect(run.sentMessages[0].text).toBe(
            scenario.expected.sentTextEquals,
          );
        }
      } else {
        expect(run.sentMessages).toHaveLength(0);
      }

      if (scenario.expected.providerCalled !== undefined) {
        expect(run.providerCallCount > 0).toBe(
          scenario.expected.providerCalled,
        );
      }

      if (scenario.expected.skippedReasonIncludes) {
        expect(run.result.skippedReason).toContain(
          scenario.expected.skippedReasonIncludes,
        );
      }

      if (scenario.expected.retiredReason === 'expired') {
        expect(run.loggedEvents).toContainEqual(
          expect.objectContaining({
            eventType: 'question_retired',
            eventData: expect.objectContaining({ reason: 'expired' }),
          }),
        );
        expect(run.retiredQuestionIds).toContain('q1');
      }

      if (scenario.expected.retiredReason === 'superseded_by_activity') {
        expect(run.loggedEvents).toContainEqual(
          expect.objectContaining({
            eventType: 'question_retired',
            eventData: expect.objectContaining({
              reason: 'superseded_by_activity',
            }),
          }),
        );
        expect(run.retiredQuestionIds).toContain('q1');
      }

      if (scenario.id === 'paused-family-suppresses-send') {
        // #6a: a paused family's pending question must survive untouched,
        // ready to send once the family resumes -- not retired as a side
        // effect of the pause.
        expect(run.finalQuestionStatus).toBe('proposed');
      }
    });
  }
});
