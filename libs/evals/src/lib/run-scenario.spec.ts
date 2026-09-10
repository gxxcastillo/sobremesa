import { describe, expect, it } from 'vitest';
import {
  buildScenarioPrompt,
  createEvent,
  InMemoryEventRepository,
  makeContext,
  makeProcessorContext,
  offsetTime,
} from './run-scenario';
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

describe('InMemoryEventRepository', () => {
  it('matches the production findRecent signature when filtering by sequence', async () => {
    const scenario = makeScenario();
    const events = Array.from({ length: 5 }, (_, index) =>
      createEvent({
        scenario,
        message: scenario.messages[0],
        sender: scenario.senders.rosa,
        sequenceNumber: index + 1,
        occurredAt: offsetTime(index + 1),
      }),
    );
    const repository = new InMemoryEventRepository(events);
    const recent = await repository.findRecent(
      'eval-family-preview-test',
      'eval-chat-preview-test',
      30,
      false,
      3,
    );
    expect(recent.map((event) => event.sequenceNumber)).toEqual([2, 1]);
  });
});

describe('makeProcessorContext', () => {
  it('uses the production character budget while makeContext remains count-truncated', () => {
    const scenario = makeScenario();
    const longMessage = { sender: 'rosa', text: 'x'.repeat(200) };
    const events = Array.from({ length: 41 }, (_, index) =>
      createEvent({
        scenario,
        message: longMessage,
        sender: scenario.senders.rosa,
        sequenceNumber: index + 1,
        occurredAt: offsetTime(index + 1),
      }),
    );
    const current = events[40];
    const context = makeProcessorContext(events, current, scenario.messages[0]);
    const legacyContext = makeContext(
      events,
      current,
      30,
      scenario.messages[0],
    );
    expect(context.recentMessages).toHaveLength(12);
    expect(legacyContext.recentMessages).toHaveLength(30);
    expect(context.recentMessages[0]?.id).toBe('preview-test-29');
  });
});
