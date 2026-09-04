import type {
  AICompletionRequest,
  AICompletionResponse,
  AIProvider,
} from '@sobremesa/ai-provider';

/**
 * One `.complete()` call captured verbatim: the exact request sent (system
 * prompt, user messages, schema, temperature) and either the raw response
 * text or the error, so a run can show what was actually sent to the LLM and
 * what came back — not just the parsed/aggregated output.
 */
export interface RecordedCall {
  request: AICompletionRequest;
  response?: AICompletionResponse;
  error?: string;
  startedAt: string;
  durationMs: number;
}

/**
 * Wraps any `AIProvider` and records every `complete()` call it makes,
 * without changing its behavior — real calls still go out, real responses
 * still come back. Used so `POST /api/runs` can return the actual prompt(s)
 * and response(s) a run produced, since `runScenario`/`ScribeAgent` discard
 * them once the domain model is parsed out.
 */
export class RecordingProvider implements AIProvider {
  readonly name: string;
  readonly calls: RecordedCall[] = [];

  constructor(private readonly inner: AIProvider) {
    this.name = inner.name;
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    const startedAt = new Date();
    const start = Date.now();
    try {
      const response = await this.inner.complete(request);
      this.calls.push({
        request,
        response,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - start,
      });
      return response;
    } catch (err) {
      this.calls.push({
        request,
        error: err instanceof Error ? err.message : String(err),
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - start,
      });
      throw err;
    }
  }

  supportsVision(): boolean {
    return this.inner.supportsVision();
  }

  async isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }
}
