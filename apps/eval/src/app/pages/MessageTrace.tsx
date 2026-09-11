import {
  createResource,
  createSignal,
  createEffect,
  For,
  Show,
  createMemo,
} from 'solid-js';
import { A, useNavigate, useParams } from '@solidjs/router';
import {
  api,
  type EventLogEntry,
  type FamilyEvent,
  type MessageTraceResult,
  type Run,
  type RunSummary,
  type RunWithAnnotations,
} from '../api';
import { LlmCalls } from '../components/LlmCalls';
import { Modal } from '../components/Modal';

// Module-scoped so the family list backing the <select>'s <option>s survives
// navigating to another page and back — Solid unmounts MessageTrace() on
// route change, which would otherwise refetch it from scratch every time.
const [families] = createResource(() => api.getFamilies());

// Module-scoped (rather than a signal local to TraceEventRow) so expanded
// messages stay expanded across the same unmount/remount: navigate to
// another page and back and whatever you had open is still open.
const [expandedEventIds, setExpandedEventIds] = createSignal<
  ReadonlySet<string>
>(new Set());
function toggleEventExpanded(id: string): void {
  setExpandedEventIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
}

// The currently open family on the trace page, kept live so the shell's nav
// header can link back to it instead of resetting to the bare /trace picker.
export const [currentTraceFamilyId, setCurrentTraceFamilyId] = createSignal('');

/**
 * Explains, in plain language, whether/why this message reached an LLM at
 * all — the thing the raw event_log rows don't say outright. Derived
 * entirely from data already in the trace; no new backend field.
 */
function pipelineExplanation(trace: MessageTraceResult): string {
  const routed = trace.eventLog.find(
    (e) => e.actor === 'router' && e.eventData?.['stage'] === 'routed',
  );
  const filtered = trace.eventLog.find((e) => e.eventType === 'event_filtered');
  const registrarSummary = trace.eventLog.find(
    (e) => e.actor === 'registrar' && e.eventType === 'event_processed',
  );
  const rejectedClaims = trace.eventLog.filter(
    (e) => e.eventType === 'claim_rejected',
  );
  const groundingFailedClaims = trace.produced.claims.filter(
    (c) => c.analysis?.grounding === 'failed',
  );
  const rejectionNote =
    rejectedClaims.length > 0
      ? ` ${rejectedClaims.length} claim(s) were rejected below: evidence matched only a prior context message, not this one (context bleed).`
      : '';
  const groundingNote =
    groundingFailedClaims.length > 0
      ? ` ${groundingFailedClaims.length} persisted claim(s) have evidence that matched neither this message nor context — kept, but flagged \`grounding: failed\` (possible paraphrase or hallucination).`
      : '';

  if (trace.event.eventType !== 'message') {
    return `Non-text event ("${trace.event.eventType}") — Intern's filter skips these deterministically ("let Scribe handle those"), and the processor only runs Scribe when there's text content. Nothing here called an LLM.`;
  }
  // trace.intern is the latest `intern_evaluated` event_log entry -- the
  // canonical, append-only record of every InternAgent.route() call, for
  // every ingress (live chat, Studio import, CLI import) alike. It is an
  // observed pipeline result, not a reviewable decision.
  if (trace.intern) {
    const methodNote =
      trace.intern.method === 'deterministic'
        ? ' (deterministic, no LLM call)'
        : ` (model call${trace.intern.tokensUsed ? `, ${trace.intern.tokensUsed} tokens` : ''})`;
    if (trace.intern.action === 'ignore') {
      return `Intern routed this to ignore${methodNote}: ${trace.intern.reason}. No extraction call was made.`;
    }
    if (trace.intern.action === 'admin') {
      return `Intern routed this to admin${methodNote}: ${trace.intern.reason}. This is deterministic command/DM/mention handling, not a Scribe-relevance judgment.`;
    }
    return `Intern routed this to ${trace.intern.action}${methodNote}: ${trace.intern.reason}. Scribe ${registrarSummary ? 'ran and recorded a persist summary.' : 'has no recorded persist summary.'}${rejectionNote}${groundingNote}`;
  }
  // Historical data predating the universal intern_evaluated audit event
  // (see .agents/plans/unified-import-pipeline-plan.md item 1) falls back
  // to the older, ambiguous markers it replaced.
  if (filtered) {
    const reason = filtered.eventData?.['reason'] ?? 'no reason recorded';
    return `Intern's filter call rejected this before Scribe ran: ${reason}. No extraction call was made.`;
  }
  if (routed) {
    const data = routed.eventData ?? {};
    return `Intern routed this to "${data['action']}" (${data['reason'] ?? 'no reason recorded'})${
      data['language'] ? `, detected language ${data['language']}` : ''
    }. Scribe then ran${registrarSummary ? '.' : ' — no persist summary was recorded, though.'}${rejectionNote}${groundingNote}`;
  }
  if (registrarSummary) {
    return `No Intern activity was recorded for this event. Scribe ran unconditionally.${rejectionNote}${groundingNote}`;
  }
  return 'No routing decision and no Scribe/Registrar summary recorded — this message may never have reached the queue processor.';
}

function fmt(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function eventLogSummary(entry: EventLogEntry): string {
  const data = entry.eventData ?? {};
  const parts = Object.entries(data)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  return parts.join(' · ');
}

function EventLogTimeline(props: { entries: EventLogEntry[] }) {
  return (
    <ul class="trace-timeline">
      <For each={props.entries}>
        {(entry) => (
          <li classList={{ [`severity-${entry.severity}`]: true }}>
            <div class="trace-timeline-head">
              <span class="trace-time">{fmt(entry.createdAt)}</span>
              <span class="category-tag">{entry.eventType}</span>
              <span class="trace-actor">{entry.actor ?? entry.actorType}</span>
            </div>
            <Show when={eventLogSummary(entry)}>
              <div class="trace-timeline-detail">{eventLogSummary(entry)}</div>
            </Show>
          </li>
        )}
      </For>
      <Show when={props.entries.length === 0}>
        <li class="hint">
          No event_log entries — never reached the queue processor.
        </li>
      </Show>
    </ul>
  );
}

function RunLlmCalls(props: { run: Run }) {
  return (
    <For each={props.run.results}>
      {(entry) => (
        <div class="trace-run-config">
          <Show when={props.run.results.length > 1}>
            <div class="hint">
              {entry.provider}/{entry.model}
            </div>
          </Show>
          <LlmCalls calls={entry.llmCalls} />
        </div>
      )}
    </For>
  );
}

function PastRunEntry(props: {
  run: RunSummary;
  onViewRun: (id: string) => void;
}) {
  const [expanded, setExpanded] = createSignal(false);
  const [full] = createResource(expanded, () => api.getRun(props.run.id));

  return (
    <div class="trace-past-run">
      <button
        type="button"
        class="btn-inline"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded() ? '▾ hide' : '▸ show'}{' '}
        {props.run.configs.map((c) => c.model).join(', ')} (
        {new Date(props.run.createdAt).toLocaleString()})
      </button>{' '}
      <button
        type="button"
        class="btn-inline"
        onClick={() => props.onViewRun(props.run.id)}
      >
        open full run →
      </button>
      <Show when={expanded()}>
        <Show when={full.error}>
          <div class="error-message">
            {full.error instanceof Error
              ? full.error.message
              : String(full.error)}
          </div>
        </Show>
        <Show when={!full.error}>
          <Show when={full()} fallback={<p class="hint">Loading…</p>}>
            {(run) => <RunLlmCalls run={run()} />}
          </Show>
        </Show>
      </Show>
    </div>
  );
}

function TraceCard(props: {
  familyId: string;
  trace: MessageTraceResult;
  runs: RunSummary[];
  onViewRun: (id: string) => void;
}) {
  const { event, queue, processing, eventLog, redaction, produced } =
    props.trace;
  const interpretation = createMemo(
    () =>
      processing?.processingMetadata?.['interpretation'] as
        | {
            resolvedText?: string;
            resolutionConfidence?: string;
            ambiguousReferences?: Array<{
              token: string;
              candidates: string[];
              selected: string;
              confidence: number;
            }>;
          }
        | undefined,
  );
  const pastRuns = createMemo(() =>
    props.runs
      .filter((r) => r.input.kind === 'real' && r.input.eventId === event.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  );

  const runLiveHref = `/?mode=real&familyId=${encodeURIComponent(props.familyId)}&eventId=${encodeURIComponent(event.id)}`;

  return (
    <div class="card trace-card">
      <div class="trace-card-header">
        <div>
          <strong>#{event.sequenceNumber}</strong>{' '}
          {event.actorDisplayName ?? event.actorUsername ?? 'Unknown'} ·{' '}
          {fmt(event.occurredAt)}
          <Show when={event.ingestionBatchId}>
            <span class="category-tag">imported</span>
          </Show>
          <Show when={!event.ingestionBatchId}>
            <span class="category-tag">live</span>
          </Show>
        </div>
        <Show when={queue}>
          {(q) => (
            <span
              class="score-badge"
              classList={{
                pass: q().status === 'done',
                fail: q().status === 'error',
              }}
            >
              queue: {q().status}
              {q().attempts > 0
                ? ` (${q().attempts} attempt${q().attempts === 1 ? '' : 's'})`
                : ''}
            </span>
          )}
        </Show>
        <Show when={!queue}>
          <span class="score-badge fail">never queued</span>
        </Show>
      </div>

      <p class="trace-content">
        {event.contentOriginal || '(no text content)'}
      </p>

      <Show when={queue?.lastError}>
        <div class="error-message">last error: {queue?.lastError}</div>
      </Show>

      <div class="trace-intern">
        <h3>Intern activity</h3>
        <Show
          when={props.trace.intern}
          fallback={
            <p class="hint">
              No persisted Intern activity — this event predates the universal
              `intern_evaluated` audit event, or nothing routed it through
              `InternAgent.route()`.
            </p>
          }
        >
          {(activity) => (
            <div>
              <span
                class="category-tag"
                classList={{
                  'severity-warning-tag': activity().action === 'ignore',
                }}
              >
                {activity().action}
              </span>{' '}
              {activity().reason}
              <div class="hint">
                relevant: {String(activity().relevant)} · method:{' '}
                {activity().method}
                {activity().model ? ` (${activity().model})` : ''}
                {activity().language
                  ? ` · language: ${activity().language}`
                  : ''}
              </div>
              <div class="hint">Observed {fmt(activity().observedAt)}</div>
            </div>
          )}
        </Show>
      </div>

      <Show when={redaction}>
        {(r) => (
          <div class="error-message">
            redacted at {fmt(r().redactedAt)}: {r().redactionReason}
          </div>
        )}
      </Show>

      <Show when={interpretation()}>
        {(interp) => (
          <div class="trace-interpretation">
            <span class="category-tag">interpreted</span>{' '}
            {interp().resolvedText}
            <Show when={interp().resolutionConfidence}>
              {' '}
              ({interp().resolutionConfidence})
            </Show>
            <Show when={(interp().ambiguousReferences?.length ?? 0) > 0}>
              <ul class="trace-ambiguous-refs">
                <For each={interp().ambiguousReferences}>
                  {(ref) => (
                    <li>
                      "{ref.token}" → {ref.selected}
                      <Show when={ref.candidates.length > 1}>
                        {' '}
                        <span class="hint">
                          (considered: {ref.candidates.join(', ')}, confidence{' '}
                          {ref.confidence})
                        </span>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
        )}
      </Show>

      <div class="trace-why">
        <span class="category-tag">why</span> {pipelineExplanation(props.trace)}
      </div>

      <h4>
        Pipeline{' '}
        <A class="btn-inline" href={runLiveHref}>
          run live to see prompt & response →
        </A>
      </h4>
      <Show when={pastRuns().length > 0}>
        <div class="trace-past-runs">
          <span class="hint">Past runs of this message:</span>
          <For each={pastRuns()}>
            {(run) => <PastRunEntry run={run} onViewRun={props.onViewRun} />}
          </For>
        </div>
      </Show>
      <EventLogTimeline entries={eventLog} />

      <h4>Persisted because of this message</h4>
      <Show
        when={
          produced.claims.length +
            produced.relationships.length +
            produced.people.length +
            produced.places.length +
            produced.merges.length >
          0
        }
        fallback={<p class="hint">Nothing persisted from this message.</p>}
      >
        <For each={produced.people}>
          {(p) => (
            <div class="extraction-item">
              <span class="category-tag">
                {p.isPlaceholder ? 'placeholder person' : 'person'}
              </span>{' '}
              {p.name}
              <Show when={p.aliases.length > 0}>
                {' '}
                <span class="hint">({p.aliases.join(', ')})</span>
              </Show>
            </div>
          )}
        </For>
        <For each={produced.places}>
          {(p) => (
            <div class="extraction-item">
              <span class="category-tag">place</span> {p.name}
              <Show when={p.type || p.country}>
                {' '}
                <span class="hint">
                  ({[p.type, p.city, p.country].filter(Boolean).join(', ')})
                </span>
              </Show>
            </div>
          )}
        </For>
        <For each={produced.relationships}>
          {(r) => (
            <div class="extraction-item">
              <span class="category-tag">relationship</span> {r.personAName} ↔{' '}
              {r.personBName}
              <span class="hint"> ({r.relationshipType})</span>
            </div>
          )}
        </For>
        <For each={produced.claims}>
          {(c) => (
            <div class="extraction-item">
              <span class="category-tag">claim</span> {c.subject}
              <div class="extraction-detail">
                {typeof c.claimValue === 'string'
                  ? c.claimValue
                  : JSON.stringify(c.claimValue)}{' '}
                ({c.claimType}, {c.claimedBySource}
                {c.attributedTo ? ` → ${c.attributedTo}` : ''})
              </div>
              <Show when={c.analysis}>
                {(a) => (
                  <div class="extraction-detail hint">
                    strength: {a().claimStrength ?? '—'}
                    {a().inferenceMethod ? ` (${a().inferenceMethod})` : ''}
                    <Show when={a().grounding === 'failed'}>
                      {' '}
                      <span class="category-tag severity-warning-tag">
                        grounding: failed
                      </span>
                    </Show>
                  </div>
                )}
              </Show>
              <Show when={c.conflicts.length > 0}>
                <div class="extraction-detail">
                  <span class="category-tag severity-warning-tag">
                    conflicts with
                  </span>
                  <For each={c.conflicts}>
                    {(conflict) => (
                      <div class="hint">
                        {conflict.subject ?? conflict.claimId}:{' '}
                        {typeof conflict.claimValue === 'string'
                          ? conflict.claimValue
                          : JSON.stringify(conflict.claimValue)}{' '}
                        (claimed by {conflict.claimedBy ?? 'unknown'},{' '}
                        {conflict.status})
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          )}
        </For>
        <For each={produced.merges}>
          {(m) => (
            <div class="extraction-item">
              <span class="category-tag">entity merge</span>{' '}
              {m.sourceEntityName ?? m.sourceEntityType}
              {' → '}
              {m.targetEntityName ?? m.targetEntityType}
              <div class="extraction-detail">
                {m.mergeStrategy ?? 'unknown strategy'}
                {m.confidence != null ? `, confidence ${m.confidence}` : ''}
                {m.mergedBy ? ` (by ${m.mergedBy})` : ''}
                <Show when={m.mergeReason}>
                  <div class="hint">{m.mergeReason}</div>
                </Show>
              </div>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}

function TraceEventRow(props: {
  event: FamilyEvent;
  familyId: string;
  runs: RunSummary[];
  onViewRun: (id: string) => void;
}) {
  const expanded = () => expandedEventIds().has(props.event.id);
  const [trace] = createResource(
    () => (expanded() ? props.event.id : undefined),
    (id) => api.getTrace(props.familyId, [id]).then((results) => results[0]),
  );

  return (
    <div class="trace-event-item">
      <button
        type="button"
        class="trace-event-row"
        onClick={() => toggleEventExpanded(props.event.id)}
      >
        <span class="trace-event-toggle">{expanded() ? '▾' : '▸'}</span>
        <span class="hint">
          #{props.event.sequenceNumber} [
          {new Date(props.event.occurredAt).toLocaleString()}]
        </span>{' '}
        {props.event.actorDisplayName ?? props.event.actorUsername}:{' '}
        {(props.event.contentOriginal ?? '').slice(0, 100)}
      </button>
      <Show when={expanded()}>
        <div class="trace-event-detail">
          <Show when={trace.error}>
            <div class="error-message">
              {trace.error instanceof Error
                ? trace.error.message
                : String(trace.error)}
            </div>
          </Show>
          <Show when={!trace.error}>
            <Show when={trace()} fallback={<p class="hint">Loading…</p>}>
              {(t) => (
                <TraceCard
                  familyId={props.familyId}
                  trace={t()}
                  runs={props.runs}
                  onViewRun={props.onViewRun}
                />
              )}
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  );
}

export function MessageTrace() {
  const params = useParams<{ familyId?: string; eventId?: string }>();
  const navigate = useNavigate();
  const familyId = () => params.familyId ?? '';
  const setFamilyId = (id: string) => navigate(id ? `/trace/${id}` : '/trace');
  // A deep link from Family Compare's "trace →" links (or anywhere else that
  // knows an exact event id) jumps straight to that one message instead of
  // the paginated family timeline below — see the `jumpEventId()` branch in
  // the JSX. Fetches the trace directly (`api.getTrace`, same call
  // `TraceEventRow` makes when expanded), so it works regardless of which
  // page of the timeline that event would otherwise fall on.
  const jumpEventId = () => params.eventId ?? '';
  const [jumpTrace] = createResource(
    () => (jumpEventId() ? ([familyId(), jumpEventId()] as const) : undefined),
    ([fid, eid]) => api.getTrace(fid, [eid]).then((results) => results[0]),
  );
  const [jumpRuns] = createResource(
    () => (jumpEventId() ? ([familyId(), jumpEventId()] as const) : undefined),
    ([fid, eid]) => api.listRuns({ familyId: fid, eventIds: [eid] }),
  );

  const EVENTS_PAGE_SIZE = 100;
  const [events, setEvents] = createSignal<FamilyEvent[]>([]);
  const [eventsError, setEventsError] = createSignal<unknown>(null);
  const [loadingEvents, setLoadingEvents] = createSignal(false);
  const [hasMoreEvents, setHasMoreEvents] = createSignal(false);

  // Runs for exactly the events currently loaded above, fetched per page
  // rather than as a bounded recency window — "does a run exist for this
  // message" has to stay correct no matter how old the message is or how
  // many other runs this family has accumulated since. Accumulates across
  // pages the same way `events` does.
  const [runs, setRuns] = createSignal<RunSummary[]>([]);

  async function loadEventsPage(id: string, offset: number) {
    setLoadingEvents(true);
    setEventsError(null);
    try {
      const page = await api.getFamilyEvents(id, EVENTS_PAGE_SIZE, { offset });
      setEvents((prev) => (offset === 0 ? page : [...prev, ...page]));
      setHasMoreEvents(page.length === EVENTS_PAGE_SIZE);
      const runsPage =
        page.length > 0
          ? await api.listRuns({
              familyId: id,
              eventIds: page.map((e) => e.id),
            })
          : [];
      setRuns((prev) => (offset === 0 ? runsPage : [...prev, ...runsPage]));
    } catch (err) {
      setEventsError(err);
    } finally {
      setLoadingEvents(false);
    }
  }

  // Newest-first pages, one family at a time — a family growing mid-session
  // could shift an item across the offset boundary, but that's an accepted
  // limitation of offset paging on a live table, same as elsewhere in this
  // app (`getAllFamilyEvents`'s docstring).
  createEffect(() => {
    const id = familyId();
    setEvents([]);
    setRuns([]);
    setHasMoreEvents(false);
    if (id) void loadEventsPage(id, 0);
  });

  function loadMoreEvents() {
    const id = familyId();
    if (id) void loadEventsPage(id, events().length);
  }

  const [modalRun, setModalRun] = createSignal<RunWithAnnotations | null>(null);
  const viewRun = async (id: string) => setModalRun(await api.getRun(id));

  // A deep link (or browser back/forward) can select a familyId before the
  // <option>s exist in the DOM — the <select>'s `value` binding only tracks
  // familyId(), not the families() list, so it can't retry on its own once
  // the list arrives. Re-apply it here once the options are actually there.
  // eslint-disable-next-line no-unassigned-vars -- assigned by Solid's `ref={selectEl}` compiler macro below, invisible to static analysis
  let selectEl: HTMLSelectElement | undefined;
  createEffect(() => {
    // `families.error` checked first: reading `families()` once it has
    // errored re-throws (Solid's resource behavior), which would break this
    // effect instead of just skipping the resync.
    if (!families.error && families() && selectEl) selectEl.value = familyId();
  });

  createEffect(() => setCurrentTraceFamilyId(familyId()));

  return (
    <div class="page">
      <h2>Message Trace</h2>
      <p class="hint">
        Pick real messages and see exactly how they moved through the pipeline —
        queue status, the event_log narrative, and everything persisted because
        of them. Read-only; writes nothing.
      </p>

      <Show when={jumpEventId()}>
        <p class="hint">
          Jumped straight to one message.{' '}
          <A href={`/trace/${familyId()}`}>
            ← browse this family's full timeline
          </A>
        </p>
        <Show when={jumpTrace.error}>
          <div class="error-message">
            {jumpTrace.error instanceof Error
              ? jumpTrace.error.message
              : String(jumpTrace.error)}
          </div>
        </Show>
        <Show when={!jumpTrace.error}>
          <Show when={jumpTrace()} fallback={<p class="hint">Loading…</p>}>
            {(t) => (
              <TraceCard
                familyId={familyId()}
                trace={t()}
                runs={jumpRuns() ?? []}
                onViewRun={viewRun}
              />
            )}
          </Show>
        </Show>
      </Show>

      <Show when={!jumpEventId()}>
        <section class="card">
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
              ref={selectEl}
              value={familyId()}
              onChange={(e) => setFamilyId(e.currentTarget.value)}
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
            <div class="trace-event-list">
              <For each={events()}>
                {(event) => (
                  <TraceEventRow
                    event={event}
                    familyId={familyId()}
                    runs={runs()}
                    onViewRun={viewRun}
                  />
                )}
              </For>
            </div>
            <Show when={eventsError()}>
              <div class="error-message">
                {eventsError() instanceof Error
                  ? (eventsError() as Error).message
                  : String(eventsError())}
              </div>
            </Show>
            <Show when={loadingEvents()}>
              <p class="hint">Loading…</p>
            </Show>
            <Show when={!loadingEvents() && hasMoreEvents()}>
              <button type="button" onClick={loadMoreEvents}>
                Load more
              </button>
            </Show>
          </Show>
        </section>
      </Show>

      <Show when={modalRun()}>
        {(run) => (
          <Modal
            title={`Run · ${run()
              .configs.map((c) => c.model)
              .join(', ')}`}
            onClose={() => setModalRun(null)}
          >
            <p class="hint">
              {new Date(run().createdAt).toLocaleString()} —{' '}
              {JSON.stringify(run().input)}
            </p>
            <RunLlmCalls run={run()} />
          </Modal>
        )}
      </Show>
    </div>
  );
}
