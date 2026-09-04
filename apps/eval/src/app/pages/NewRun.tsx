import {
  createSignal,
  createResource,
  createMemo,
  createEffect,
  on,
  For,
  Index,
  Show,
  Switch,
  Match,
} from 'solid-js';
import { useNavigate, useSearchParams } from '@solidjs/router';
import {
  api,
  type Confidence,
  type ContextMessageOverride,
  type FamilyEvent,
  type MessagePreview,
  type PrimaryLanguage,
  type RunConfig,
  type RunInput,
  type Thoroughness,
} from '../api';

type Mode = 'scenario' | 'adhoc' | 'real';

let configKeySeq = 0;

export function NewRun() {
  const navigate = useNavigate();
  // Deep-link from Message Trace's "run live" — `/?mode=real&familyId=..&eventId=..`
  // preselects the message here instead of running it immediately, so the
  // family/message/prompt/context are all editable before anything runs.
  // A real navigation (not an inline fetch), so the URL reflects it and the
  // browser back button returns to the trace page.
  const [searchParams] = useSearchParams();
  const [mode, setMode] = createSignal<Mode>(
    searchParams.mode === 'real' ? 'real' : 'scenario',
  );
  const [error, setError] = createSignal<string | null>(null);
  const [submitting, setSubmitting] = createSignal(false);

  const [scenarios] = createResource(() => api.getScenarios());
  const [families] = createResource(() => api.getFamilies());
  // Powers the model datalist for the 'local'/'lan' providers below — live
  // Ollama model ids instead of a free-typed guess.
  const [providers] = createResource(() => api.getProviders());

  const [scenarioId, setScenarioId] = createSignal('');
  const [adhocText, setAdhocText] = createSignal('');
  const [adhocSender, setAdhocSender] = createSignal('You');
  const [familyId, setFamilyId] = createSignal(
    typeof searchParams.familyId === 'string' ? searchParams.familyId : '',
  );
  const [eventId, setEventId] = createSignal(
    typeof searchParams.eventId === 'string' ? searchParams.eventId : '',
  );
  const [events] = createResource(familyId, (id) =>
    id ? api.getFamilyEvents(id, 100) : Promise.resolve<FamilyEvent[]>([]),
  );

  // "Real message" preview — everything Sobremesa would send alongside the
  // selected message, with the prompt and the prior-context window editable
  // before the run (eval-tool-v2-plan.md decision #4, revised).
  // `contextWindowInput` defaults to however many prior messages the
  // pipeline actually included for the selected message (not a guessed
  // number) — `contextWindowTouched` tracks whether the user has overridden
  // that for the current message, so the field keeps tracking reality until
  // they explicitly ask for a different window.
  const [contextWindowInput, setContextWindowInput] = createSignal(30);
  const [contextWindowTouched, setContextWindowTouched] = createSignal(false);
  const [thoroughness, setThoroughness] =
    createSignal<Thoroughness>('standard');
  const [confidence, setConfidence] = createSignal<Confidence>('moderate');
  const [scribeName, setScribeName] = createSignal('Scribe');
  const [primaryLanguage, setPrimaryLanguage] =
    createSignal<PrimaryLanguage>('en');

  const [preview, setPreview] = createSignal<MessagePreview | null>(null);
  const [previewLoading, setPreviewLoading] = createSignal(false);
  const [previewError, setPreviewError] = createSignal<string | null>(null);
  const [promptText, setPromptText] = createSignal('');
  const [contextMessages, setContextMessages] = createSignal<
    ContextMessageOverride[]
  >([]);

  // loadPreview is fired from several independent onChange handlers
  // (thoroughness, confidence, language, scribeName, context-window), so two
  // calls can be in flight at once. previewRequestId guards against an
  // older response landing after a newer one and clobbering its state.
  let previewRequestId = 0;

  async function loadPreview(resetContext: boolean) {
    const fid = familyId();
    const eid = eventId();
    if (!fid || !eid) return;

    const requestId = ++previewRequestId;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const result = await api.getMessagePreview(fid, eid, {
        // Untouched: let the server apply its own default window rather than
        // carrying over a count discovered for a previously selected
        // message, which would only ever shrink from message to message.
        contextWindow: contextWindowTouched()
          ? contextWindowInput()
          : undefined,
        thoroughness: thoroughness(),
        confidence: confidence(),
        scribeName: scribeName(),
        primaryLanguage: primaryLanguage(),
      });
      if (requestId !== previewRequestId) return;
      setPreview(result);
      setPromptText(result.systemPrompt);
      if (!contextWindowTouched()) {
        setContextWindowInput(result.context.length);
      }
      if (resetContext) {
        setContextMessages(result.context);
      }
      if (resetContext && result.scribeConfig) {
        setThoroughness(result.scribeConfig.thoroughness ?? 'standard');
        setConfidence(result.scribeConfig.confidence ?? 'moderate');
        setScribeName(result.scribeConfig.scribeName ?? 'Scribe');
        setPrimaryLanguage(result.scribeConfig.primaryLanguage ?? 'en');
      }
    } catch (err) {
      if (requestId !== previewRequestId) return;
      setPreviewError(
        err instanceof Error ? err.message : 'Failed to load preview',
      );
    } finally {
      if (requestId === previewRequestId) {
        setPreviewLoading(false);
      }
    }
  }

  // Selecting a different family/message resets the whole preview (prompt,
  // context edits, knobs) — a knob or context-window change instead only
  // regenerates the prompt (`loadPreview(false)`, wired to each control's
  // onChange below), so it never discards in-progress context edits.
  createEffect(
    on([familyId, eventId], ([fid, eid]) => {
      setPreview(null);
      setPromptText('');
      setContextMessages([]);
      setPreviewError(null);
      setContextWindowTouched(false);
      if (fid && eid) void loadPreview(true);
    }),
  );

  const removeContextMessage = (index: number) =>
    setContextMessages((prev) => prev.filter((_, i) => i !== index));
  const updateContextMessageText = (index: number, text: string) =>
    setContextMessages((prev) =>
      prev.map((m, i) => (i === index ? { ...m, text } : m)),
    );
  const contextEdited = createMemo(() => {
    const defaults = preview()?.context ?? [];
    const current = contextMessages();
    return (
      defaults.length !== current.length ||
      defaults.some((m, i) => m.text !== current[i]?.text)
    );
  });

  const [configs, setConfigs] = createSignal<
    Array<RunConfig & { key: number }>
  >([
    {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      key: configKeySeq++,
    },
  ]);

  const addConfig = () =>
    setConfigs((prev) => [
      ...prev,
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5-20250929',
        key: configKeySeq++,
      },
    ]);
  const removeConfig = (key: number) =>
    setConfigs((prev) => prev.filter((c) => c.key !== key));
  const updateConfig = (key: number, patch: Partial<RunConfig>) =>
    setConfigs((prev) =>
      prev.map((c) => (c.key === key ? { ...c, ...patch } : c)),
    );

  // 'anthropic' has no live listing (no equivalent of Ollama's /v1/models
  // endpoint here) — the datalist stays empty and the field is free text,
  // same as today.
  const ollamaStatus = (provider: RunConfig['provider']) => {
    // `providers.error` checked first: reading `providers()` once it has
    // errored re-throws (Solid's resource behavior) instead of just
    // returning undefined, which would break the model row's render.
    if (providers.error) return undefined;
    if (provider === 'local') return providers()?.local;
    if (provider === 'lan') return providers()?.lan;
    return undefined;
  };

  const canSubmit = createMemo(() => {
    if (configs().length === 0) return false;
    if (mode() === 'scenario') return scenarioId() !== '';
    if (mode() === 'adhoc') return adhocText().trim() !== '';
    if (mode() === 'real') return familyId() !== '' && eventId() !== '';
    return false;
  });

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setError(null);

    let input: RunInput;
    if (mode() === 'scenario') {
      input = { kind: 'scenario', scenarioId: scenarioId() };
    } else if (mode() === 'adhoc') {
      input = {
        kind: 'adhoc',
        text: adhocText(),
        senderName: adhocSender() || undefined,
      };
    } else {
      const loaded = preview();
      input = {
        kind: 'real',
        familyId: familyId(),
        eventId: eventId(),
        contextWindow: contextWindowInput(),
        ...(loaded
          ? {
              contextOverride: contextMessages(),
              scribeConfig: {
                thoroughness: thoroughness(),
                confidence: confidence(),
                scribeName: scribeName(),
                primaryLanguage: primaryLanguage(),
              },
              systemPromptOverride: promptText() || undefined,
            }
          : {}),
      };
    }

    const runConfigs: RunConfig[] = configs().map(({ provider, model }) => ({
      provider,
      model,
    }));

    setSubmitting(true);
    try {
      const run = await api.createRun(input, runConfigs);
      navigate(`/runs/${run.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start run');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div class="page">
      <h2>New Run</h2>

      <form onSubmit={handleSubmit}>
        <section class="card">
          <h3>Input</h3>
          <div class="mode-tabs">
            <button
              type="button"
              classList={{ active: mode() === 'scenario' }}
              onClick={() => setMode('scenario')}
            >
              Curated scenario
            </button>
            <button
              type="button"
              classList={{ active: mode() === 'adhoc' }}
              onClick={() => setMode('adhoc')}
            >
              Ad hoc text
            </button>
            <button
              type="button"
              classList={{ active: mode() === 'real' }}
              onClick={() => setMode('real')}
            >
              Real message
            </button>
          </div>

          <Switch>
            <Match when={mode() === 'scenario'}>
              <Show when={scenarios.error}>
                <div class="error-message">
                  {scenarios.error instanceof Error
                    ? scenarios.error.message
                    : String(scenarios.error)}
                </div>
              </Show>
              <label>
                Scenario
                <select
                  value={scenarioId()}
                  onChange={(e) => setScenarioId(e.currentTarget.value)}
                >
                  <option value="">Select a scenario…</option>
                  <Show when={!scenarios.error}>
                    <For each={scenarios()}>
                      {(s) => (
                        <option value={s.id}>
                          {s.id} — {s.description}
                        </option>
                      )}
                    </For>
                  </Show>
                </select>
              </label>
              <p class="hint">Scored against its golden expectations.</p>
            </Match>

            <Match when={mode() === 'adhoc'}>
              <label>
                Sender name
                <input
                  type="text"
                  value={adhocSender()}
                  onInput={(e) => setAdhocSender(e.currentTarget.value)}
                />
              </label>
              <label>
                Message text
                <textarea
                  rows={4}
                  value={adhocText()}
                  onInput={(e) => setAdhocText(e.currentTarget.value)}
                  placeholder="Type any message to extract from…"
                />
              </label>
              <p class="hint">Not scored — raw extraction only.</p>
            </Match>

            <Match when={mode() === 'real'}>
              <Show when={families.error}>
                <div class="error-message">
                  {families.error instanceof Error
                    ? families.error.message
                    : String(families.error)}
                </div>
              </Show>
              <label>
                Family
                <select
                  value={familyId()}
                  onChange={(e) => {
                    setFamilyId(e.currentTarget.value);
                    setEventId('');
                  }}
                >
                  <option value="">Select a family…</option>
                  <Show when={!families.error}>
                    <For each={families()}>
                      {(f) => <option value={f.id}>{f.name}</option>}
                    </For>
                  </Show>
                </select>
              </label>
              <Show when={familyId()}>
                <Show when={events.error}>
                  <div class="error-message">
                    {events.error instanceof Error
                      ? events.error.message
                      : String(events.error)}
                  </div>
                </Show>
                <label>
                  Message
                  <select
                    value={eventId()}
                    onChange={(e) => setEventId(e.currentTarget.value)}
                  >
                    <option value="">Select a message…</option>
                    <Show when={!events.error}>
                      <For each={events()}>
                        {(event) => (
                          <option value={event.id}>
                            [{new Date(event.occurredAt).toLocaleString()}]{' '}
                            {event.actorDisplayName ?? event.actorUsername}:{' '}
                            {(event.contentOriginal ?? '').slice(0, 80)}
                          </option>
                        )}
                      </For>
                    </Show>
                  </select>
                </label>
              </Show>

              <Show when={familyId() && eventId()}>
                <Show when={previewLoading() && !preview()}>
                  <p class="hint">Loading what Sobremesa would send…</p>
                </Show>
                <Show when={previewError()}>
                  <div class="error-message">{previewError()}</div>
                </Show>
                <Show when={preview()}>
                  {(p) => (
                    <Show
                      when={!p().empty}
                      fallback={
                        <p class="hint">
                          This message has no text content — Scribe would return
                          an empty extraction without sending any prompt.
                        </p>
                      }
                    >
                      <div class="preview-section">
                        <h4>Context Sobremesa would include</h4>
                        <label class="context-window-label">
                          Prior messages to fetch
                          <input
                            type="number"
                            min="0"
                            max="200"
                            value={contextWindowInput()}
                            onChange={(e) => {
                              setContextWindowInput(
                                Number(e.currentTarget.value) || 0,
                              );
                              setContextWindowTouched(true);
                              void loadPreview(true);
                            }}
                          />
                        </label>
                        <p class="hint">
                          Defaults to however many messages Sobremesa actually
                          included for this message — oldest first, exactly as
                          Scribe would see them. Edit or remove any before
                          running.
                        </p>
                        <Show when={contextMessages().length === 0}>
                          <p class="hint">No prior context messages.</p>
                        </Show>
                        <Index each={contextMessages()}>
                          {(msg, i) => (
                            <details class="context-message">
                              <summary class="context-message-summary">
                                <strong>{msg().senderName}</strong>
                                <span class="trace-time">
                                  {msg().occurredAt
                                    ? new Date(
                                        msg().occurredAt as string,
                                      ).toLocaleString()
                                    : ''}
                                </span>
                                <span class="context-message-preview">
                                  {msg().text}
                                </span>
                              </summary>
                              <div class="context-message-body">
                                <textarea
                                  rows={2}
                                  value={msg().text}
                                  onInput={(e) =>
                                    updateContextMessageText(
                                      i,
                                      e.currentTarget.value,
                                    )
                                  }
                                />
                                <button
                                  type="button"
                                  class="btn-remove"
                                  title="Remove this message from context"
                                  onClick={() => removeContextMessage(i)}
                                >
                                  ✕ remove from context
                                </button>
                              </div>
                            </details>
                          )}
                        </Index>
                        <Show when={contextEdited()}>
                          <button
                            type="button"
                            class="btn-inline"
                            onClick={() =>
                              setContextMessages(preview()?.context ?? [])
                            }
                          >
                            Reset context to defaults
                          </button>
                        </Show>
                      </div>

                      <div class="preview-section">
                        <h4>The message being processed</h4>
                        <div class="context-message read-only">
                          <div class="context-message-head">
                            <strong>{p().message.senderName}</strong>
                            <span class="trace-time">
                              {new Date(
                                p().message.occurredAt,
                              ).toLocaleString()}
                            </span>
                          </div>
                          <p class="trace-content">{p().message.text}</p>
                        </div>
                      </div>

                      <div class="preview-section">
                        <h4>System prompt</h4>
                        <div class="config-row prompt-knobs">
                          <label>
                            Thoroughness
                            <select
                              value={thoroughness()}
                              onChange={(e) => {
                                setThoroughness(
                                  e.currentTarget.value as Thoroughness,
                                );
                                void loadPreview(false);
                              }}
                            >
                              <option value="essential">essential</option>
                              <option value="standard">standard</option>
                              <option value="comprehensive">
                                comprehensive
                              </option>
                            </select>
                          </label>
                          <label>
                            Confidence
                            <select
                              value={confidence()}
                              onChange={(e) => {
                                setConfidence(
                                  e.currentTarget.value as Confidence,
                                );
                                void loadPreview(false);
                              }}
                            >
                              <option value="strict">strict</option>
                              <option value="moderate">moderate</option>
                              <option value="lenient">lenient</option>
                            </select>
                          </label>
                          <label>
                            Primary language
                            <select
                              value={primaryLanguage()}
                              onChange={(e) => {
                                setPrimaryLanguage(
                                  e.currentTarget.value as PrimaryLanguage,
                                );
                                void loadPreview(false);
                              }}
                            >
                              <option value="en">en</option>
                              <option value="es">es</option>
                            </select>
                          </label>
                          <label>
                            Scribe name
                            <input
                              type="text"
                              value={scribeName()}
                              onChange={(e) => {
                                setScribeName(e.currentTarget.value);
                                void loadPreview(false);
                              }}
                            />
                          </label>
                        </div>
                        <p class="hint">
                          Changing a knob regenerates the prompt below from
                          Scribe's real template. Hand edits after that are sent
                          exactly as typed.
                        </p>
                        <textarea
                          class="llm-text prompt-editor"
                          rows={16}
                          value={promptText()}
                          onInput={(e) => setPromptText(e.currentTarget.value)}
                        />
                        <button
                          type="button"
                          class="btn-inline"
                          onClick={() => void loadPreview(false)}
                        >
                          Reset prompt to default
                        </button>
                      </div>
                    </Show>
                  )}
                </Show>
              </Show>
              <p class="hint">
                Not scored — uses the preceding messages as context, same as the
                real pipeline would.
              </p>
            </Match>
          </Switch>
        </section>

        <section class="card">
          <h3>Models to compare</h3>
          <For each={configs()}>
            {(config) => (
              <div>
                <div class="config-row">
                  <select
                    value={config.provider}
                    onChange={(e) =>
                      updateConfig(config.key, {
                        provider: e.currentTarget
                          .value as RunConfig['provider'],
                      })
                    }
                  >
                    <option value="anthropic">anthropic</option>
                    <option value="local">local (this Mac's Ollama)</option>
                    <option value="lan">lan (Ollama on another machine)</option>
                  </select>
                  <input
                    type="text"
                    list={`models-${config.provider}-${config.key}`}
                    value={config.model}
                    onInput={(e) =>
                      updateConfig(config.key, { model: e.currentTarget.value })
                    }
                    placeholder="model id"
                  />
                  <datalist id={`models-${config.provider}-${config.key}`}>
                    <For each={ollamaStatus(config.provider)?.models ?? []}>
                      {(model) => <option value={model} />}
                    </For>
                  </datalist>
                  <button
                    type="button"
                    class="btn-remove"
                    onClick={() => removeConfig(config.key)}
                    disabled={configs().length <= 1}
                  >
                    ✕
                  </button>
                </div>
                <Show when={ollamaStatus(config.provider)}>
                  {(s) => (
                    <p class="hint">
                      <Show
                        when={s().baseUrl}
                        fallback={
                          <>
                            lan not configured — set{' '}
                            <code>LOCAL_LAN_LLM_BASE_URL</code> and restart the
                            eval server.
                          </>
                        }
                      >
                        {(baseUrl) => (
                          <Show
                            when={s().models.length > 0}
                            fallback={
                              <>
                                No models found at {baseUrl()} — is Ollama
                                running there? Typing a model id still works.
                              </>
                            }
                          >
                            {s().models.length} model
                            {s().models.length === 1 ? '' : 's'} found at{' '}
                            {baseUrl()}.
                          </Show>
                        )}
                      </Show>
                    </p>
                  )}
                </Show>
              </div>
            )}
          </For>
          <button type="button" onClick={addConfig}>
            + Add model
          </button>
        </section>

        <Show when={error()}>
          <div class="error-message">{error()}</div>
        </Show>

        <button
          type="submit"
          class="btn-primary"
          disabled={!canSubmit() || submitting()}
        >
          {submitting() ? 'Running…' : 'Run'}
        </button>
      </form>
    </div>
  );
}
