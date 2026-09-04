import { describe, expect, it } from 'vitest';
import { buildScenarioPrompt } from './run-scenario';
import type { ScribeEvalScenario } from './scenario';

function makeScenario(
  overrides?: Partial<ScribeEvalScenario>,
): ScribeEvalScenario {
  return {
    id: 'preview-test',
    description: 'preview test scenario',
    senders: {
      rosa: { id: 'rosa', displayName: 'Rosa' },
      mateo: { id: 'mateo', displayName: 'Mateo' },
    },
    messages: [{ sender: 'rosa', text: 'My mother was born in Oaxaca.' }],
    ...overrides,
  };
}

describe('buildScenarioPrompt', () => {
  it('builds the system/user prompt without calling any provider', async () => {
    const built = await buildScenarioPrompt(makeScenario());

    expect(built.empty).toBe(false);
    if (built.empty) throw new Error('expected a non-empty build');
    expect(built.systemPrompt).toContain('Scribe');
    expect(built.userMessage).toContain('My mother was born in Oaxaca.');
  });

  it('includes prior context messages in the built user message', async () => {
    const built = await buildScenarioPrompt(
      makeScenario({
        initialContext: [{ sender: 'mateo', text: 'Remember grandma Rosa?' }],
      }),
    );

    expect(built.empty).toBe(false);
    if (built.empty) throw new Error('expected a non-empty build');
    expect(built.userMessage).toContain('Remember grandma Rosa?');
    expect(built.userMessage).toContain('Mateo');
  });

  it('applies a config override into the rendered system prompt', async () => {
    const built = await buildScenarioPrompt(makeScenario(), {
      scribeName: 'CustomScribe',
    });

    expect(built.empty).toBe(false);
    if (built.empty) throw new Error('expected a non-empty build');
    expect(built.systemPrompt).toContain('CustomScribe');
    expect(built.config.scribeName).toBe('CustomScribe');
  });

  it('rejects scenarios with more than one message', async () => {
    await expect(
      buildScenarioPrompt(
        makeScenario({
          messages: [
            { sender: 'rosa', text: 'First.' },
            { sender: 'rosa', text: 'Second.' },
          ],
        }),
      ),
    ).rejects.toThrow(/single-message/);
  });
});
