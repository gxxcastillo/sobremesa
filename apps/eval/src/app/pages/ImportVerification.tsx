import { createResource, createSignal, For, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { api, type ImportVerificationReport } from '../api';

const [families] = createResource(() => api.getFamilies());

function EventLink(props: {
  familyId: string;
  eventId: string;
  label: string;
}) {
  return (
    <A href={`/trace/${props.familyId}/${props.eventId}`}>{props.label}</A>
  );
}

function ReviewRow(props: {
  report: ImportVerificationReport;
  row: ImportVerificationReport['rows'][number];
}) {
  const candidate = () => props.row.candidateEvent;
  return (
    <tr>
      <td>
        <EventLink
          familyId={props.report.baseline.id}
          eventId={props.row.baselineEvent.id}
          label={`#${props.row.baselineEvent.sequenceNumber}`}
        />
        <div class="verification-message">
          {(props.row.baselineEvent.contentOriginal ?? '').slice(0, 180)}
        </div>
        <div class="hint">
          {props.row.baselineActiveClaims} original active claim(s)
        </div>
      </td>
      <td>
        <Show
          when={candidate()}
          fallback={<span class="score-badge fail">missing</span>}
        >
          {(event) => (
            <>
              <EventLink
                familyId={props.report.candidate.id}
                eventId={event().id}
                label={`#${event().sequenceNumber}`}
              />
              <div>
                <span
                  class="score-badge"
                  classList={{
                    pass: props.row.inputMatches,
                    fail: !props.row.inputMatches,
                  }}
                >
                  {props.row.inputMatches ? 'input matches' : 'input differs'}
                </span>
              </div>
            </>
          )}
        </Show>
      </td>
      <td>
        <Show
          when={props.row.intern}
          fallback={<span class="score-badge fail">no decision</span>}
        >
          {(intern) => (
            <>
              <span
                class="score-badge"
                classList={{
                  pass: intern().decision === 'process',
                  fail: intern().decision === 'skip',
                }}
              >
                {intern().decision}
              </span>
              <div class="verification-reason">{intern().reason}</div>
              <Show when={intern().overridden}>
                <div class="hint">Human override</div>
              </Show>
            </>
          )}
        </Show>
      </td>
      <td>
        <span
          class="score-badge"
          classList={{
            pass:
              props.row.candidateActiveClaims === 0 &&
              props.row.intern?.decision === 'skip',
            fail:
              props.row.candidateActiveClaims > 0 &&
              props.row.intern?.decision === 'skip',
          }}
        >
          {props.row.candidateActiveClaims} active claim(s)
        </span>
      </td>
    </tr>
  );
}

export function ImportVerification() {
  const [baselineId, setBaselineId] = createSignal('');
  const [candidateId, setCandidateId] = createSignal('');
  const [request, setRequest] = createSignal<readonly [string, string] | null>(
    null,
  );
  const [report] = createResource(request, ([baseline, candidate]) =>
    api.getImportVerification(baseline, candidate),
  );

  function compare() {
    if (baselineId() && candidateId() && baselineId() !== candidateId()) {
      setRequest([baselineId(), candidateId()]);
    }
  }

  return (
    <div class="page">
      <h2>Import Verification</h2>
      <p class="hint">
        Compare an original family with a fresh import. This is read-only and
        highlights every source message that created an active claim in the
        original family.
      </p>
      <section class="card verification-picker">
        <label>
          Original family
          <select
            value={baselineId()}
            onChange={(event) => setBaselineId(event.currentTarget.value)}
          >
            <option value="">Select the original import…</option>
            <For each={families() ?? []}>
              {(family) => <option value={family.id}>{family.name}</option>}
            </For>
          </select>
        </label>
        <label>
          Fresh re-import
          <select
            value={candidateId()}
            onChange={(event) => setCandidateId(event.currentTarget.value)}
          >
            <option value="">Select the fresh import…</option>
            <For each={families() ?? []}>
              {(family) => <option value={family.id}>{family.name}</option>}
            </For>
          </select>
        </label>
        <button
          class="btn-primary"
          type="button"
          disabled={
            !baselineId() || !candidateId() || baselineId() === candidateId()
          }
          onClick={compare}
        >
          Compare imports
        </button>
        <Show when={baselineId() === candidateId() && baselineId()}>
          <p class="error-message">Choose two different families.</p>
        </Show>
      </section>

      <Show when={report.error}>
        <div class="error-message">
          {report.error instanceof Error
            ? report.error.message
            : String(report.error)}
        </div>
      </Show>
      <Show when={report.loading}>
        <p class="hint">
          Comparing source events, Intern decisions, and active claims…
        </p>
      </Show>
      <Show when={report()}>
        {(data) => <VerificationReport report={data()} />}
      </Show>
    </div>
  );
}

function VerificationReport(props: { report: ImportVerificationReport }) {
  const rowsNeedingReview = () =>
    props.report.rows.filter(
      (row) =>
        row.intern?.decision === 'skip' ||
        !row.inputMatches ||
        !row.candidateEvent ||
        row.candidateActiveClaims === 0,
    );
  return (
    <>
      <section class="verification-summary">
        <div class="card">
          <strong>{props.report.input.matched}</strong>
          <span> matching inputs</span>
          <div class="hint">
            {props.report.input.mismatched} differ ·{' '}
            {props.report.input.missing} missing
          </div>
        </div>
        <div class="card">
          <strong>{props.report.intern.process}</strong>
          <span> Intern process</span>
          <div class="hint">
            {props.report.intern.skip} skip · {props.report.intern.missing}{' '}
            missing
          </div>
        </div>
        <div class="card">
          <strong>{rowsNeedingReview().length}</strong>
          <span> rows to review</span>
          <div class="hint">from original claim-producing messages</div>
        </div>
      </section>
      <section class="card">
        <h3>Messages to review</h3>
        <p class="hint">
          A skipped candidate with zero active claims is expected for off-topic
          material; open Message Trace to inspect the reason and full downstream
          record.
        </p>
        <div class="verification-table-wrap">
          <table class="verification-table">
            <thead>
              <tr>
                <th>Original message</th>
                <th>Fresh input</th>
                <th>Intern</th>
                <th>Fresh output</th>
              </tr>
            </thead>
            <tbody>
              <For each={rowsNeedingReview()}>
                {(row) => <ReviewRow report={props.report} row={row} />}
              </For>
            </tbody>
          </table>
        </div>
        <Show when={rowsNeedingReview().length === 0}>
          <p class="hint">No original claim-producing messages need review.</p>
        </Show>
      </section>
    </>
  );
}
