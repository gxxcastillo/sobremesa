import { describe, expect, it } from 'vitest';
import { scoreInternRun } from './intern-scorer';
import type { InternScenarioRunResult } from './run-intern-scenario';
import type { ScribeEvalScenario } from './scenario';

const scenario: ScribeEvalScenario = {
  id: 'intern-score-test',
  description: 'score test',
  senders: { rosa: { id: 'rosa', displayName: 'Rosa' } },
  messages: [
    { sender: 'rosa', text: 'hello' },
    { sender: 'rosa', text: 'hola' },
  ],
  internGolden: [
    { action: 'scribe', relevant: true, language: 'en' },
    undefined,
  ],
};

describe('scoreInternRun', () => {
  it('scores exact asserted fields and leaves sparse expectations unscored', () => {
    const result: InternScenarioRunResult = {
      scenario,
      decisions: [
        {
          messageIndex: 0,
          action: 'scribe',
          relevant: true,
          reason: 'relevant',
          language: 'en',
          calledModel: true,
        },
        {
          messageIndex: 1,
          action: 'ignore',
          relevant: false,
          reason: 'noise',
          calledModel: false,
        },
      ],
    };
    expect(scoreInternRun(result, scenario)).toMatchObject({
      total: 3,
      matched: 3,
      accuracy: 1,
      mismatches: [],
    });
  });

  it('reports a mismatch for each wrong asserted field', () => {
    const result: InternScenarioRunResult = {
      scenario,
      decisions: [
        {
          messageIndex: 0,
          action: 'ignore',
          relevant: false,
          reason: 'noise',
          language: 'es',
          calledModel: false,
        },
      ],
    };
    expect(scoreInternRun(result, scenario).mismatches).toHaveLength(3);
  });
});
