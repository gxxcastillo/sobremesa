import { describe, expect, it } from 'vitest';
import type { AICompletionResponse, AIProvider } from '@sobremesa/ai-provider';
import { runInternScenario } from './run-intern-scenario';
import type { ScribeEvalScenario } from './scenario';

const unusedProvider: AIProvider = {
  name: 'unused',
  async complete(): Promise<AICompletionResponse> {
    throw new Error('emoji-only routing must not call a provider');
  },
  supportsVision: () => false,
  async isAvailable() {
    return true;
  },
};

describe('runInternScenario', () => {
  it('records a free heuristic decision without database access or a model call', async () => {
    const scenario: ScribeEvalScenario = {
      id: 'emoji-only',
      description: 'emoji-only',
      senders: { rosa: { id: 'rosa', displayName: 'Rosa' } },
      messages: [{ sender: 'rosa', text: '😂' }],
    };
    const result = await runInternScenario(scenario, unusedProvider, 'test');
    expect(result.error).toBeUndefined();
    expect(result.decisions).toMatchObject([
      { action: 'ignore', relevant: false, calledModel: false },
    ]);
  });
});
