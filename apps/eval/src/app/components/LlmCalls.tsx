import { For, Show } from 'solid-js';
import type { RecordedCall } from '../api';

export function asString(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

export function LlmCalls(props: { calls: RecordedCall[] | undefined }) {
  const calls = () => props.calls ?? [];
  return (
    <Show
      when={calls().length > 0}
      fallback={<p class="hint">No LLM call was made for this config.</p>}
    >
      <For each={calls()}>
        {(call, index) => (
          <details class="llm-call">
            <summary>
              LLM call {index() + 1}/{calls().length} — {call.request.model}
              <Show when={call.response}>
                {(response) => (
                  <>
                    {' '}
                    ({response().usage.inputTokens}→
                    {response().usage.outputTokens} tokens, {call.durationMs}ms)
                  </>
                )}
              </Show>
              <Show when={call.error}> — failed</Show>
            </summary>
            <div class="llm-call-body">
              <Show when={call.request.system}>
                <h5>System prompt</h5>
                <pre class="llm-text">{call.request.system}</pre>
              </Show>
              <h5>Messages sent</h5>
              <For each={call.request.messages}>
                {(message) => (
                  <pre class="llm-text">
                    [{message.role}] {asString(message.content)}
                  </pre>
                )}
              </For>
              <Show when={call.response}>
                {(response) => (
                  <>
                    <h5>Raw response</h5>
                    <pre class="llm-text">{response().content}</pre>
                  </>
                )}
              </Show>
              <Show when={call.error}>
                <div class="error-message">{call.error}</div>
              </Show>
            </div>
          </details>
        )}
      </For>
    </Show>
  );
}
