import { createResource, createSignal, For, Show, createMemo } from 'solid-js';
import { useParams } from '@solidjs/router';
import {
  api,
  GROUNDING_FAILURE_GATE,
  type Annotation,
  type RunResultEntry,
} from '../api';
import { asString, LlmCalls } from '../components/LlmCalls';

interface FlatItem {
  category: string;
  index: number;
  label: string;
  detail: string;
}

function flatten(outputs: Array<Record<string, unknown>>): FlatItem[] {
  const items: FlatItem[] = [];
  const push = (category: string, label: string, detail: string) => {
    items.push({ category, index: items.length, label, detail });
  };

  for (const output of outputs) {
    for (const person of (output.people as Array<Record<string, unknown>>) ??
      []) {
      push(
        'people',
        asString(person.name),
        [
          person.birthYear && `b. ${person.birthYear}`,
          person.deathYear && `d. ${person.deathYear}`,
        ]
          .filter(Boolean)
          .join(', '),
      );
    }
    for (const place of (output.places as Array<Record<string, unknown>>) ??
      []) {
      push(
        'places',
        asString(place.name),
        asString(place.type ?? place.country ?? ''),
      );
    }
    for (const event of (output.events as Array<Record<string, unknown>>) ??
      []) {
      push(
        'events',
        asString(event.title),
        asString(event.dateText ?? event.dateYear ?? ''),
      );
    }
    for (const rel of (output.relationships as Array<
      Record<string, unknown>
    >) ?? []) {
      push(
        'relationships',
        `${asString(rel.personAName)} ↔ ${asString(rel.personBName)}`,
        asString(rel.relationshipType ?? ''),
      );
    }
    for (const claim of (output.claims as Array<Record<string, unknown>>) ??
      []) {
      push(
        'claims',
        asString(claim.subject),
        `${asString(claim.claimValue)} (${asString(claim.claimType)})`,
      );
    }
    if (output.story) {
      const story = output.story as Record<string, unknown>;
      push('story', asString(story.title ?? 'Story'), asString(story.content));
    }
  }

  return items;
}

function ConfigColumn(props: {
  runId: string;
  configIndex: number;
  entry: RunResultEntry;
  annotations: Annotation[];
  onAnnotated: () => void;
}) {
  const items = createMemo(() => flatten(props.entry.outputs));
  const scoreToShow = createMemo(() =>
    props.entry.score && props.entry.score.scored !== false
      ? props.entry.score
      : undefined,
  );
  // The `runtime` category is a synthetic forbidden-hit scoreScenario adds
  // when the run threw — `.error-message` above already shows that text, so
  // it's excluded here to avoid saying the same thing twice.
  const forbiddenHits = createMemo(() =>
    (scoreToShow()?.forbiddenHits ?? []).filter(
      (hit) => hit.category !== 'runtime',
    ),
  );
  const usageTotals = createMemo(() => {
    let inputTokens = 0;
    let outputTokens = 0;
    let durationMs = 0;
    for (const call of props.entry.llmCalls) {
      if (call.response) {
        inputTokens += call.response.usage.inputTokens;
        outputTokens += call.response.usage.outputTokens;
      }
      durationMs += call.durationMs;
    }
    return { inputTokens, outputTokens, durationMs };
  });
  const [pendingNote, setPendingNote] = createSignal<Record<number, string>>(
    {},
  );

  // Keyed by content (`{configIndex, category, label}`), not `flatten()`'s
  // position — a re-run of the same input can reorder extractions, and a
  // positional index would then point annotations at the wrong item.
  const annotationFor = (category: string, label: string) =>
    props.annotations.find((a) => {
      const t = a.target as {
        configIndex?: number;
        category?: string;
        label?: string;
      };
      return (
        t?.configIndex === props.configIndex &&
        t?.category === category &&
        t?.label === label
      );
    });

  const annotate = async (item: FlatItem, verdict: 'good' | 'bad') => {
    const note = pendingNote()[item.index];
    await api.annotate(
      props.runId,
      {
        configIndex: props.configIndex,
        category: item.category,
        label: item.label,
      },
      verdict,
      note || undefined,
    );
    props.onAnnotated();
  };

  // Lets a note be edited without re-clicking 👍/👎 — reuses whatever verdict
  // is already on file rather than requiring one to be asserted here. A note
  // with no verdict yet has nothing to attach to, so this no-ops until one
  // exists.
  const saveNote = async (item: FlatItem) => {
    const existing = annotationFor(item.category, item.label);
    if (!existing) return;
    const note = pendingNote()[item.index];
    if (note === undefined || note === (existing.note ?? '')) return;
    await api.annotate(
      props.runId,
      {
        configIndex: props.configIndex,
        category: item.category,
        label: item.label,
      },
      existing.verdict,
      note || undefined,
    );
    props.onAnnotated();
  };

  return (
    <div class="config-column">
      <h3>
        {props.entry.provider} / {props.entry.model}
      </h3>
      <Show when={props.entry.error}>
        <div class="error-message">{props.entry.error}</div>
      </Show>

      <Show when={props.entry.llmCalls.length > 0}>
        <div class="cost-summary">
          {usageTotals().inputTokens.toLocaleString()}→
          {usageTotals().outputTokens.toLocaleString()} tokens ·{' '}
          {(usageTotals().durationMs / 1000).toFixed(1)}s ·{' '}
          <Show when={props.entry.costEstimate} fallback={<>cost —</>}>
            {(cost) => (
              <>~${cost().totalCostUsd.toFixed(4)} (uncached estimate)</>
            )}
          </Show>
        </div>
      </Show>

      <Show when={scoreToShow()}>
        {(score) => (
          <>
            <div
              class="score-badge"
              classList={{
                pass: score().passed,
                fail: !score().passed,
                'hard-fail': score().hardFailed,
              }}
            >
              <Show
                when={!score().hardFailed}
                fallback={
                  <>
                    HARD FAILED —{' '}
                    {props.entry.error
                      ? 'the run did not complete'
                      : 'a forbidden extraction was found'}
                  </>
                }
              >
                score {score().score.toFixed(2)} · precision{' '}
                {score().precision.toFixed(2)} · recall{' '}
                {score().recall.toFixed(2)} · {score().passed ? 'PASS' : 'FAIL'}
              </Show>
            </div>

            <Show when={forbiddenHits().length > 0}>
              <ul class="forbidden-hit-list">
                <For each={forbiddenHits()}>
                  {(hit) => (
                    <li class="forbidden-hit">
                      forbidden {hit.category}: "{hit.actual}" (matched golden "
                      {hit.expected}")
                    </li>
                  )}
                </For>
              </ul>
            </Show>

            <Show when={score().grounding.totalClaims > 0}>
              {(() => {
                const grounding = score().grounding;
                const failureRate =
                  (grounding.contextBleed + grounding.unmatched) /
                  grounding.totalClaims;
                return (
                  <div
                    class="grounding-summary"
                    classList={{
                      'over-gate': failureRate > GROUNDING_FAILURE_GATE,
                    }}
                  >
                    grounding: {grounding.grounded}/{grounding.totalClaims}{' '}
                    grounded
                    <Show when={grounding.contextBleed > 0}>
                      {', '}
                      {grounding.contextBleed} claim
                      {grounding.contextBleed === 1 ? '' : 's'} re-extracted
                      from context, not from this message — the pipeline drops
                      these before persisting
                    </Show>
                    <Show when={grounding.unmatched > 0}>
                      {', '}
                      {grounding.unmatched} unmatched
                    </Show>
                    <Show when={failureRate > GROUNDING_FAILURE_GATE}>
                      {' '}
                      — over the {(GROUNDING_FAILURE_GATE * 100).toFixed(0)}%
                      grounding-failure gate
                    </Show>
                  </div>
                );
              })()}
            </Show>

            <Show when={score().categories.some((c) => c.missing.length > 0)}>
              <ul class="missing-list">
                <For each={score().categories}>
                  {(cat) => (
                    <For each={cat.missing}>
                      {(m) => (
                        <li>
                          missing {cat.category}: {m}
                        </li>
                      )}
                    </For>
                  )}
                </For>
              </ul>
            </Show>
          </>
        )}
      </Show>

      <h4>LLM calls</h4>
      <LlmCalls calls={props.entry.llmCalls} />

      <h4>Extracted</h4>
      <Show when={items().length === 0 && !props.entry.error}>
        <p class="hint">No entities or claims extracted.</p>
      </Show>

      <For each={items()}>
        {(item) => {
          const existing = annotationFor(item.category, item.label);
          return (
            <div class="extraction-item">
              <div class="extraction-label">
                <span class="category-tag">{item.category}</span> {item.label}
              </div>
              <Show when={item.detail}>
                <div class="extraction-detail">{item.detail}</div>
              </Show>
              <div class="annotate-row">
                <button
                  type="button"
                  classList={{ active: existing?.verdict === 'good' }}
                  onClick={() => annotate(item, 'good')}
                >
                  👍
                </button>
                <button
                  type="button"
                  classList={{ active: existing?.verdict === 'bad' }}
                  onClick={() => annotate(item, 'bad')}
                >
                  👎
                </button>
                <input
                  type="text"
                  placeholder="note"
                  value={pendingNote()[item.index] ?? existing?.note ?? ''}
                  onInput={(e) =>
                    setPendingNote((prev) => ({
                      ...prev,
                      [item.index]: e.currentTarget.value,
                    }))
                  }
                  onBlur={() => saveNote(item)}
                />
              </div>
            </div>
          );
        }}
      </For>
    </div>
  );
}

export function RunResult() {
  const params = useParams<{ id: string }>();
  const [run, { refetch }] = createResource(
    () => params.id,
    (id) => api.getRun(id),
  );

  return (
    <div class="page">
      <h2>Run Result</h2>
      <Show when={run.error}>
        <div class="error-message">
          {run.error instanceof Error ? run.error.message : String(run.error)}
        </div>
      </Show>
      <Show when={!run.error}>
        <Show when={run()} fallback={<p>Loading…</p>}>
          {(r) => (
            <>
              <p class="hint">
                {new Date(r().createdAt).toLocaleString()} —{' '}
                {JSON.stringify(r().input)}
              </p>
              <div class="results-grid">
                <For each={r().results}>
                  {(entry, index) => (
                    <ConfigColumn
                      runId={r().id}
                      configIndex={index()}
                      entry={entry}
                      annotations={r().annotations}
                      onAnnotated={refetch}
                    />
                  )}
                </For>
              </div>
            </>
          )}
        </Show>
      </Show>
    </div>
  );
}
