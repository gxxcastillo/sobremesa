import { describe, it, expect, vi } from 'vitest';
import { submitAnthropicBatchAndWait } from './anthropic-batch';
import type { AICompletionRequest } from './types';

const baseRequest: AICompletionRequest = {
  model: 'claude-haiku-4-5',
  maxTokens: 100,
  system: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: 'Hello!' }],
};

function fakeClient(opts: {
  create: (body: Record<string, unknown>) => unknown;
  retrieveSequence: unknown[];
  results: unknown[];
}) {
  let retrieveCall = 0;
  return {
    beta: {
      messages: {
        batches: {
          create: vi.fn(async (body: Record<string, unknown>) =>
            opts.create(body),
          ),
          retrieve: vi.fn(async () => {
            const value = opts.retrieveSequence[retrieveCall];
            retrieveCall = Math.min(
              retrieveCall + 1,
              opts.retrieveSequence.length - 1,
            );
            return value;
          }),
          results: vi.fn(async () => opts.results),
        },
      },
    },
  };
}

describe('submitAnthropicBatchAndWait', () => {
  it('returns an empty array without calling the client for no items', async () => {
    const client = fakeClient({
      create: () => ({}),
      retrieveSequence: [],
      results: [],
    });

    const result = await submitAnthropicBatchAndWait(
      client,
      'claude-haiku-4-5',
      [],
    );

    expect(result).toEqual([]);
    expect(client.beta.messages.batches.create).not.toHaveBeenCalled();
  });

  it('submits, polls until ended, and maps succeeded results back by key', async () => {
    const client = fakeClient({
      create: () => ({ id: 'batch_1', processing_status: 'in_progress' }),
      retrieveSequence: [
        {
          id: 'batch_1',
          processing_status: 'in_progress',
          request_counts: {
            processing: 1,
            succeeded: 0,
            errored: 0,
            canceled: 0,
            expired: 0,
          },
        },
        {
          id: 'batch_1',
          processing_status: 'ended',
          request_counts: {
            processing: 0,
            succeeded: 1,
            errored: 0,
            canceled: 0,
            expired: 0,
          },
        },
      ],
      results: [
        {
          custom_id: 'key-1',
          result: {
            type: 'succeeded',
            message: {
              content: [{ type: 'text', text: '{"ok":true}' }],
              model: 'claude-haiku-4-5',
              stop_reason: 'end_turn',
              usage: { input_tokens: 10, output_tokens: 5 },
            },
          },
        },
      ],
    });
    const onProgress = vi.fn();

    const result = await submitAnthropicBatchAndWait(
      client,
      'claude-haiku-4-5',
      [{ key: 'key-1', request: baseRequest }],
      { pollIntervalMs: 1, onProgress },
    );

    expect(result).toEqual([
      {
        key: 'key-1',
        response: {
          content: '{"ok":true}',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          model: 'claude-haiku-4-5',
          stopReason: 'end_turn',
        },
      },
    ]);
    expect(client.beta.messages.batches.retrieve).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  it('reports errored and missing results without throwing, in item order', async () => {
    const client = fakeClient({
      create: () => ({ id: 'batch_2', processing_status: 'ended' }),
      retrieveSequence: [
        {
          id: 'batch_2',
          processing_status: 'ended',
          request_counts: {
            processing: 0,
            succeeded: 0,
            errored: 1,
            canceled: 0,
            expired: 0,
          },
        },
      ],
      results: [
        {
          custom_id: 'key-b',
          result: { type: 'errored', error: { message: 'rate limited' } },
        },
        // 'key-a' is deliberately absent from the results stream.
      ],
    });

    const result = await submitAnthropicBatchAndWait(
      client,
      'claude-haiku-4-5',
      [
        { key: 'key-a', request: baseRequest },
        { key: 'key-b', request: baseRequest },
      ],
    );

    expect(result).toEqual([
      { key: 'key-a', error: 'missing from batch results' },
      { key: 'key-b', error: expect.stringContaining('errored') },
    ]);
  });

  it('applies betas once at the batch level, not inside each request', async () => {
    let createBody: Record<string, unknown> | undefined;
    const client = fakeClient({
      create: (body) => {
        createBody = body;
        return { id: 'batch_3', processing_status: 'ended' };
      },
      retrieveSequence: [
        { id: 'batch_3', processing_status: 'ended', request_counts: {} },
      ],
      results: [],
    });

    await submitAnthropicBatchAndWait(client, 'claude-haiku-4-5', [
      {
        key: 'key-1',
        request: {
          ...baseRequest,
          responseFormat: {
            type: 'json_schema',
            json_schema: {
              name: 'test',
              schema: {
                type: 'object',
                properties: {},
                additionalProperties: false,
              },
            },
          },
        },
      },
    ]);

    expect(createBody?.['betas']).toEqual(['structured-outputs-2025-11-13']);
    const requests = createBody?.['requests'] as Array<{
      params: Record<string, unknown>;
    }>;
    expect(requests[0]?.params['betas']).toBeUndefined();
  });
});
