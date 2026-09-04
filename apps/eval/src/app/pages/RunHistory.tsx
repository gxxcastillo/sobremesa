import { createResource, For, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { api, type RunInput } from '../api';

function describeInput(input: RunInput): string {
  switch (input.kind) {
    case 'scenario':
      return `scenario: ${input.scenarioId}`;
    case 'adhoc':
      return `ad hoc: "${input.text.slice(0, 60)}"`;
    case 'real':
      return `real message ${input.eventId}`;
  }
}

export function RunHistory() {
  const [runs, { refetch }] = createResource(() =>
    api.listRuns({ limit: 100 }),
  );

  return (
    <div class="page">
      <h2>Run History</h2>
      <button type="button" onClick={() => refetch()}>
        Refresh
      </button>

      <Show when={runs.error}>
        <div class="error-message">
          {runs.error instanceof Error
            ? runs.error.message
            : String(runs.error)}
        </div>
      </Show>
      {/* Reading `runs()` after it has errored re-throws — gating on
          `!runs.error` first keeps that read from ever happening, instead of
          just hiding the "Loading…" text while still crashing the render. */}
      <Show when={!runs.error}>
        <Show when={runs()} fallback={<p>Loading…</p>}>
          <table class="run-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Input</th>
                <th>Configs</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <For each={runs()}>
                {(run) => (
                  <tr>
                    <td>{new Date(run.createdAt).toLocaleString()}</td>
                    <td>{describeInput(run.input)}</td>
                    <td>
                      {run.configs
                        .map((c) => `${c.provider}/${c.model}`)
                        .join(', ')}
                    </td>
                    <td>
                      <A href={`/runs/${run.id}`}>Open</A>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
          <Show when={runs()?.length === 0}>
            <p>No runs yet.</p>
          </Show>
        </Show>
      </Show>
    </div>
  );
}
