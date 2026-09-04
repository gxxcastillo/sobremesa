import { Elysia } from 'elysia';
import { scribeEvalScenarios } from '@sobremesa/evals';

export function scenarioRoutes() {
  return new Elysia().get('/api/scenarios', () =>
    scribeEvalScenarios.map((scenario) => ({
      id: scenario.id,
      description: scenario.description,
      messageCount: scenario.messages.length,
      contextMessageCount: scenario.initialContext?.length ?? 0,
    })),
  );
}
