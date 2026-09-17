import {
  createSignal,
  createResource,
  createEffect,
  createMemo,
  on,
  For,
  Show,
  type JSX,
  type Resource,
} from 'solid-js';
import { A } from '@solidjs/router';
import {
  api,
  type ClaimType,
  type FamilyEvent,
  type FamilyMeta,
  type FamilyStats,
  type FamilyPersonRow,
  type FamilyPlaceRow,
  type FamilyRelationshipRow,
  type FamilyStoryRow,
  type FamilyTimelineEventRow,
  type FamilyClaimRow,
  type FamilyClaimConflictRow,
  type FamilyClaimContradictionRow,
  type GoldenExpectation,
  type TextExpectation,
  type ExpectedPerson,
  type ExpectedPlace,
  type ExpectedRelationship,
  type ExpectedStory,
  type ExpectedEvent,
  type ExpectedClaim,
  type FamilyGoldenScore,
} from '../api';

const CLAIM_TYPES: ClaimType[] = [
  'date',
  'location',
  'relationship',
  'detail',
  'identity',
];

/**
 * Selected family ids, at module scope rather than inside `FamilyCompare` --
 * Solid Router unmounts the route component on navigation, which would reset
 * a local `createSignal` and force re-picking both families every visit.
 * Mirrors `currentTraceFamilyId` in `MessageTrace.tsx`.
 */
const [familyIdA, setFamilyIdA] = createSignal('');
const [familyIdB, setFamilyIdB] = createSignal('');

type MatchStatus = 'match' | 'mismatch' | 'onlyA' | 'onlyB';

interface MatchTick {
  status: MatchStatus;
  a?: FamilyEvent;
  b?: FamilyEvent;
}

function normalizedContent(e: FamilyEvent | undefined): string {
  return (e?.contentOriginal ?? '').trim();
}

function normalizedActor(e: FamilyEvent | undefined): string {
  return (e?.actorDisplayName ?? e?.actorUsername ?? '').trim().toLowerCase();
}

function describeEvent(e: FamilyEvent | undefined): string {
  if (!e) return '(no message at this position)';
  const who = e.actorDisplayName ?? e.actorUsername ?? 'unknown';
  const text = (e.contentOriginal ?? '').slice(0, 80);
  return `${who}: ${text}`;
}

function tickTitle(tick: MatchTick): string {
  switch (tick.status) {
    case 'match':
      return `Match — ${describeEvent(tick.a)}`;
    case 'mismatch':
      return `Mismatch\nA: ${describeEvent(tick.a)}\nB: ${describeEvent(tick.b)}`;
    case 'onlyA':
      return `Only in A: ${describeEvent(tick.a)}`;
    case 'onlyB':
      return `Only in B: ${describeEvent(tick.b)}`;
  }
}

function buildMatchTicks(
  eventsA: FamilyEvent[],
  eventsB: FamilyEvent[],
): MatchTick[] {
  const len = Math.max(eventsA.length, eventsB.length);
  const ticks: MatchTick[] = [];
  for (let i = 0; i < len; i++) {
    const a = eventsA[i];
    const b = eventsB[i];
    if (a && !b) {
      ticks.push({ status: 'onlyA', a });
    } else if (!a && b) {
      ticks.push({ status: 'onlyB', b });
    } else if (
      normalizedContent(a) === normalizedContent(b) &&
      normalizedActor(a) === normalizedActor(b)
    ) {
      ticks.push({ status: 'match', a, b });
    } else {
      ticks.push({ status: 'mismatch', a, b });
    }
  }
  return ticks;
}

function InputMatchQueue(props: { familyIdA: string; familyIdB: string }) {
  const [eventsA] = createResource(
    () => props.familyIdA,
    (id) => api.getAllFamilyEvents(id),
  );
  const [eventsB] = createResource(
    () => props.familyIdB,
    (id) => api.getAllFamilyEvents(id),
  );

  const loading = () => eventsA.loading || eventsB.loading;
  const loadError = () => (eventsA.error ?? eventsB.error) as Error | undefined;

  // getAllFamilyEvents already returns sequence_number-ascending order (the
  // family's actual insertion order), so no re-sorting needed here.
  const ticks = () =>
    buildMatchTicks(eventsA()?.events ?? [], eventsB()?.events ?? []);

  const summary = () => {
    const t = ticks();
    const mismatches = t.filter((tick) => tick.status !== 'match').length;
    const capped = Boolean(eventsA()?.capped || eventsB()?.capped);
    return { total: t.length, mismatches, capped };
  };

  return (
    <section class="card input-match-card">
      <h3>Input match</h3>
      <Show when={loadError()}>
        <div class="error-message">
          Failed to load events for comparison: {loadError()?.message}
        </div>
      </Show>
      <Show when={!loadError()}>
        <Show when={!loading()} fallback={<p class="hint">Checking inputs…</p>}>
          <Show
            when={summary().total > 0}
            fallback={<p class="hint">Neither family has any events yet.</p>}
          >
            {(() => {
              const s = summary();
              const identical = s.mismatches === 0;
              return (
                <>
                  <div
                    class={`input-match-banner ${identical ? 'identical' : 'differs'}`}
                  >
                    {identical
                      ? `✓ Identical input — all ${s.total} messages match`
                      : `⚠ Inputs differ — ${s.total - s.mismatches}/${s.total} messages match, ${s.mismatches} differ`}
                    {s.capped &&
                      ' (comparison capped at 5000 messages per family)'}
                  </div>
                  <div
                    class="input-match-queue"
                    aria-label="Per-message match indicators, oldest first"
                  >
                    <For each={ticks()}>
                      {(tick) => (
                        <span
                          class={`match-tick match-tick-${tick.status}`}
                          title={tickTitle(tick)}
                        />
                      )}
                    </For>
                  </div>
                </>
              );
            })()}
          </Show>
        </Show>
      </Show>
    </section>
  );
}

/**
 * What a clicked stat row drills into. `claimType` only applies to
 * `kind: 'claims'` (unset means "all active claims", set means one of the
 * per-type subrows) — kept as a flat shape rather than a discriminated union
 * so `DrillPanel` can dispatch on `kind` without fighting Solid's `Show`
 * over type narrowing (see the `keyed` note on its usage below).
 */
interface DrillCategory {
  kind:
    | 'people'
    | 'places'
    | 'relationships'
    | 'stories'
    | 'events'
    | 'claims'
    | 'claimConflicts'
    | 'claimContradictions';
  claimType?: ClaimType;
  label: string;
}

function fmtValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function fmtDate(value: string): string {
  return new Date(value).toLocaleDateString();
}

function fmtLifespan(birth: number | null, death: number | null): string {
  if (birth == null && death == null) return '—';
  if (birth != null && death != null) return `${birth}–${death}`;
  return birth != null ? `b. ${birth}` : `d. ${death}`;
}

function fmtEventDate(e: FamilyTimelineEventRow): string {
  if (e.dateYear != null && e.dateText) return `${e.dateYear} (${e.dateText})`;
  if (e.dateYear != null) return String(e.dateYear);
  return e.dateText ?? '—';
}

function fmtLocation(p: FamilyPlaceRow): string {
  return [p.city, p.region, p.country].filter(Boolean).join(', ') || '—';
}

function fmtClaimant(c: FamilyClaimRow): string {
  if (c.claimedBySource === 'direct') return c.claimedBy;
  const attribution = c.attributedTo ? ` → ${c.attributedTo}` : '';
  return `${c.claimedBy} (${c.claimedBySource}${attribution})`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * "Work backwards" link: given a persisted entity's provenance
 * (`sourceEventId`/`sourceEventIds`, threaded through from `families.ts`'s
 * drill-down routes), jump straight to Message Trace for the exact message
 * that produced it — queue status, the event_log narrative, and everything
 * else that already happened to that message. `null`/empty means the
 * pipeline never recorded provenance for this row (nothing to jump to).
 */
function TraceLink(props: {
  familyId: string;
  eventId: string | null | undefined;
}) {
  return (
    <Show when={props.eventId}>
      {(eventId) => (
        <A
          class="btn-inline trace-link"
          href={`/trace/${props.familyId}/${eventId()}`}
        >
          trace →
        </A>
      )}
    </Show>
  );
}

function EntityFlags(props: {
  placeholder?: boolean | null;
  redacted?: boolean;
  supersededBy?: string | null;
}) {
  return (
    <>
      <Show when={props.placeholder}>
        <span class="category-tag">placeholder</span>
      </Show>
      <Show when={props.supersededBy}>
        <span class="category-tag">merged away</span>
      </Show>
      <Show when={props.redacted}>
        <span class="category-tag severity-warning-tag">redacted</span>
      </Show>
    </>
  );
}

/** Common loading/error/empty scaffold shared by every drill-down list below. */
function ResourceList<T>(props: {
  resource: Resource<T[]>;
  empty: string;
  children: (items: T[]) => JSX.Element;
}) {
  return (
    <>
      <Show when={props.resource.error}>
        <div class="error-message">
          {(props.resource.error as Error).message}
        </div>
      </Show>
      {/* Reading `props.resource()` after it has errored re-throws (Solid's
          documented behavior for a resource in an error state) — gating on
          `!error` first keeps that read from happening at all, rather than
          just hiding the loading text while the render still crashes. */}
      <Show when={!props.resource.error}>
        <Show when={props.resource()} fallback={<p class="hint">Loading…</p>}>
          {(items) =>
            items().length === 0 ? (
              <p class="hint">{props.empty}</p>
            ) : (
              props.children(items())
            )
          }
        </Show>
      </Show>
    </>
  );
}

function PeopleList(props: { familyId: string }) {
  const [people] = createResource(
    () => props.familyId,
    (id) => api.getFamilyPeople(id),
  );
  return (
    <ResourceList resource={people} empty="No people yet.">
      {(items) => (
        <div class="detail-table-wrap">
          <table class="run-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Aliases</th>
                <th>Birth–death</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <For each={items as FamilyPersonRow[]}>
                {(p) => (
                  <tr>
                    <td>{p.name}</td>
                    <td>{p.aliases.length > 0 ? p.aliases.join(', ') : '—'}</td>
                    <td>{fmtLifespan(p.birthYear, p.deathYear)}</td>
                    <td>
                      <EntityFlags
                        placeholder={p.isPlaceholder}
                        redacted={p.redacted}
                        supersededBy={p.supersededBy}
                      />{' '}
                      <TraceLink
                        familyId={props.familyId}
                        eventId={p.sourceEventId}
                      />
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      )}
    </ResourceList>
  );
}

function PlacesList(props: { familyId: string }) {
  const [places] = createResource(
    () => props.familyId,
    (id) => api.getFamilyPlaces(id),
  );
  return (
    <ResourceList resource={places} empty="No places yet.">
      {(items) => (
        <div class="detail-table-wrap">
          <table class="run-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Location</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <For each={items as FamilyPlaceRow[]}>
                {(p) => (
                  <tr>
                    <td>{p.name}</td>
                    <td>{p.type ?? '—'}</td>
                    <td>{fmtLocation(p)}</td>
                    <td>
                      <EntityFlags
                        redacted={p.redacted}
                        supersededBy={p.supersededBy}
                      />{' '}
                      <TraceLink
                        familyId={props.familyId}
                        eventId={p.sourceEventId}
                      />
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      )}
    </ResourceList>
  );
}

function RelationshipsList(props: { familyId: string }) {
  const [relationships] = createResource(
    () => props.familyId,
    (id) => api.getFamilyRelationships(id),
  );
  return (
    <ResourceList resource={relationships} empty="No relationships yet.">
      {(items) => (
        <div class="detail-table-wrap">
          <table class="run-table">
            <thead>
              <tr>
                <th>Person A</th>
                <th>Person B</th>
                <th>Type</th>
                <th>Category</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <For each={items as FamilyRelationshipRow[]}>
                {(r) => (
                  <tr>
                    <td>{r.personAName ?? r.personAId}</td>
                    <td>{r.personBName ?? r.personBId}</td>
                    <td>
                      {r.relationshipType}
                      {r.qualifier ? ` (${r.qualifier})` : ''}
                    </td>
                    <td>{r.category ?? '—'}</td>
                    <td>{r.status ?? '—'}</td>
                    <td>
                      <TraceLink
                        familyId={props.familyId}
                        eventId={r.sourceEventId}
                      />
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      )}
    </ResourceList>
  );
}

function StoriesList(props: { familyId: string }) {
  const [stories] = createResource(
    () => props.familyId,
    (id) => api.getFamilyStories(id),
  );
  return (
    <ResourceList resource={stories} empty="No stories yet.">
      {(items) => (
        <div class="detail-table-wrap">
          <table class="run-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Timeframe</th>
                <th>Completeness</th>
                <th>Confidence</th>
                <th>Content</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <For each={items as FamilyStoryRow[]}>
                {(s) => (
                  <tr>
                    <td>{s.title ?? '(untitled)'}</td>
                    <td>{s.timeframe ?? '—'}</td>
                    <td>{s.completeness ?? '—'}</td>
                    <td>{s.confidence ?? '—'}</td>
                    <td>{truncate(s.contentOriginal, 120)}</td>
                    <td>
                      <For each={s.sourceEventIds}>
                        {(eventId) => (
                          <TraceLink
                            familyId={props.familyId}
                            eventId={eventId}
                          />
                        )}
                      </For>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      )}
    </ResourceList>
  );
}

function TimelineEventsList(props: { familyId: string }) {
  const [events] = createResource(
    () => props.familyId,
    (id) => api.getFamilyTimelineEvents(id),
  );
  return (
    <ResourceList resource={events} empty="No timeline events yet.">
      {(items) => (
        <div class="detail-table-wrap">
          <table class="run-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Title</th>
                <th>Type</th>
                <th>Description</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <For each={items as FamilyTimelineEventRow[]}>
                {(e) => (
                  <tr>
                    <td>{fmtEventDate(e)}</td>
                    <td>{e.title}</td>
                    <td>{e.eventType ?? '—'}</td>
                    <td>
                      {e.descriptionOriginal
                        ? truncate(e.descriptionOriginal, 120)
                        : '—'}
                    </td>
                    <td>
                      <TraceLink
                        familyId={props.familyId}
                        eventId={e.sourceEventId}
                      />
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      )}
    </ResourceList>
  );
}

function ClaimsList(props: { familyId: string; claimType?: ClaimType }) {
  const [claims] = createResource(
    () => [props.familyId, props.claimType] as const,
    ([id, type]) => api.getFamilyClaims(id, { status: 'active', type }),
  );
  return (
    <ResourceList resource={claims} empty="No active claims here.">
      {(items) => (
        <div class="detail-table-wrap">
          <table class="run-table">
            <thead>
              <tr>
                <th>Claimed at</th>
                <th>Subject</th>
                <th>Value</th>
                <th>Type</th>
                <th>Confidence</th>
                <th>Claimed by</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <For each={items as FamilyClaimRow[]}>
                {(c) => (
                  <tr>
                    <td>{fmtDate(c.claimedAt)}</td>
                    <td>{c.subject}</td>
                    <td>{fmtValue(c.claimValue)}</td>
                    <td>{c.claimType}</td>
                    <td>{c.confidence ?? '—'}</td>
                    <td>{fmtClaimant(c)}</td>
                    <td>
                      <TraceLink
                        familyId={props.familyId}
                        eventId={c.sourceEventId}
                      />
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      )}
    </ResourceList>
  );
}

function ClaimConflictsList(props: { familyId: string }) {
  const [conflicts] = createResource(
    () => props.familyId,
    (id) => api.getFamilyClaimConflicts(id),
  );
  return (
    <ResourceList resource={conflicts} empty="No claim conflicts here.">
      {(items) => (
        <div class="detail-table-wrap">
          <table class="run-table">
            <thead>
              <tr>
                <th>Claim</th>
                <th>Conflicts with</th>
                <th>Recorded</th>
              </tr>
            </thead>
            <tbody>
              <For each={items as FamilyClaimConflictRow[]}>
                {(c) => (
                  <tr>
                    <td>
                      {c.claimSubject ?? c.claimId}: {fmtValue(c.claimValue)}{' '}
                      <TraceLink
                        familyId={props.familyId}
                        eventId={c.claimSourceEventId}
                      />
                    </td>
                    <td>
                      {c.conflictsWithSubject ?? c.conflictsWithClaimId}:{' '}
                      {fmtValue(c.conflictsWithValue)}{' '}
                      <TraceLink
                        familyId={props.familyId}
                        eventId={c.conflictsWithSourceEventId}
                      />
                    </td>
                    <td>{fmtDate(c.createdAt)}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      )}
    </ResourceList>
  );
}

function ClaimContradictionsList(props: { familyId: string }) {
  const [contradictions] = createResource(
    () => props.familyId,
    (id) => api.getFamilyClaimContradictions(id),
  );
  return (
    <ResourceList
      resource={contradictions}
      empty="No contradicting claims here."
    >
      {(items) => (
        <div class="detail-table-wrap">
          <table class="run-table">
            <thead>
              <tr>
                <th>Claim</th>
                <th>Contradicts</th>
                <th>Recorded</th>
              </tr>
            </thead>
            <tbody>
              <For each={items as FamilyClaimContradictionRow[]}>
                {(c) => (
                  <tr>
                    <td>
                      {c.claimSubject ?? c.claimId}: {fmtValue(c.claimValue)}{' '}
                      <TraceLink
                        familyId={props.familyId}
                        eventId={c.claimSourceEventId}
                      />
                    </td>
                    <td>
                      {c.relatedSubject ?? c.relatedClaimId}:{' '}
                      {fmtValue(c.relatedValue)}{' '}
                      <TraceLink
                        familyId={props.familyId}
                        eventId={c.relatedSourceEventId}
                      />
                    </td>
                    <td>{fmtDate(c.createdAt)}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      )}
    </ResourceList>
  );
}

function DrillPanel(props: { familyId: string; category: DrillCategory }) {
  return (
    <div class="stat-detail">
      <h4>{props.category.label}</h4>
      {props.category.kind === 'people' && (
        <PeopleList familyId={props.familyId} />
      )}
      {props.category.kind === 'places' && (
        <PlacesList familyId={props.familyId} />
      )}
      {props.category.kind === 'relationships' && (
        <RelationshipsList familyId={props.familyId} />
      )}
      {props.category.kind === 'stories' && (
        <StoriesList familyId={props.familyId} />
      )}
      {props.category.kind === 'events' && (
        <TimelineEventsList familyId={props.familyId} />
      )}
      {props.category.kind === 'claims' && (
        <ClaimsList
          familyId={props.familyId}
          claimType={props.category.claimType}
        />
      )}
      {props.category.kind === 'claimConflicts' && (
        <ClaimConflictsList familyId={props.familyId} />
      )}
      {props.category.kind === 'claimContradictions' && (
        <ClaimContradictionsList familyId={props.familyId} />
      )}
    </div>
  );
}

function StatRow(props: {
  label: string;
  count: number;
  sub?: boolean;
  onSelect?: () => void;
}) {
  const clickable = () => Boolean(props.onSelect) && props.count > 0;
  const activate = () => {
    if (clickable()) props.onSelect?.();
  };
  return (
    <tr
      classList={{
        'stats-subrow': Boolean(props.sub),
        'stat-row-clickable': clickable(),
      }}
      tabIndex={clickable() ? 0 : undefined}
      onClick={activate}
      onKeyDown={(e) => {
        if (clickable() && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          activate();
        }
      }}
    >
      <td>{props.label}</td>
      <td>{props.count}</td>
    </tr>
  );
}

function StatsTable(props: {
  stats: FamilyStats;
  onSelect: (category: DrillCategory) => void;
}) {
  const s = () => props.stats;
  return (
    <table class="run-table">
      <tbody>
        <StatRow
          label="People"
          count={s().people}
          onSelect={() => props.onSelect({ kind: 'people', label: 'People' })}
        />
        <StatRow
          label="Places"
          count={s().places}
          onSelect={() => props.onSelect({ kind: 'places', label: 'Places' })}
        />
        <StatRow
          label="Relationships"
          count={s().relationships}
          onSelect={() =>
            props.onSelect({ kind: 'relationships', label: 'Relationships' })
          }
        />
        <StatRow
          label="Stories"
          count={s().stories}
          onSelect={() => props.onSelect({ kind: 'stories', label: 'Stories' })}
        />
        <StatRow
          label="Events"
          count={s().events}
          onSelect={() => props.onSelect({ kind: 'events', label: 'Events' })}
        />
        <StatRow
          label="Active claims"
          count={s().claimsActive}
          onSelect={() =>
            props.onSelect({ kind: 'claims', label: 'Active claims' })
          }
        />
        <For each={CLAIM_TYPES}>
          {(type) => (
            <StatRow
              sub
              label={`— ${type}`}
              count={s().claimsByType[type] ?? 0}
              onSelect={() =>
                props.onSelect({
                  kind: 'claims',
                  claimType: type,
                  label: `Active claims — ${type}`,
                })
              }
            />
          )}
        </For>
        <StatRow
          label="Claim conflicts"
          count={s().claimConflicts}
          onSelect={() =>
            props.onSelect({ kind: 'claimConflicts', label: 'Claim conflicts' })
          }
        />
        <StatRow
          label="Claims contradicting each other"
          count={s().claimRelationshipsContradicts}
          onSelect={() =>
            props.onSelect({
              kind: 'claimContradictions',
              label: 'Claims contradicting each other',
            })
          }
        />
      </tbody>
    </table>
  );
}

/**
 * A few basic facts about the family itself, distinct from `StatsTable`'s
 * extraction-output counts — meant to answer "what actually went into this
 * family" (message volume/date range, import language/timezone/source)
 * before eyeballing what came out. Excludes the LLM model used for
 * extraction: the live pipeline doesn't persist it anywhere today (checked
 * `claims`, `claim_analysis`, `conversation_event_processing`, `event_log`) —
 * see the "model tracking" follow-up noted in
 * `.agents/plans/family-compare-plan.md`.
 */
function FamilyMetaBlock(props: { familyId: string }) {
  const [meta] = createResource(
    () => props.familyId,
    (id) => api.getFamilyMeta(id),
  );

  return (
    <>
      <Show when={meta.error}>
        <div class="error-message">{(meta.error as Error).message}</div>
      </Show>
      <Show when={!meta.error}>
        <Show when={meta()} fallback={<p class="hint">Loading…</p>}>
          {(m: () => FamilyMeta) => (
            <dl class="family-meta">
              <div class="family-meta-row">
                <dt>Messages</dt>
                <dd>
                  {m().messageCount}
                  <Show when={m().firstMessageAt && m().lastMessageAt}>
                    {' '}
                    ({fmtDate(m().firstMessageAt as string)} –{' '}
                    {fmtDate(m().lastMessageAt as string)})
                  </Show>
                </dd>
              </div>
              <div class="family-meta-row">
                <dt>Language</dt>
                <dd>{m().defaultLanguage ?? '—'}</dd>
              </div>
              <div class="family-meta-row">
                <dt>Timezone</dt>
                <dd>{m().timezone ?? '—'}</dd>
              </div>
              <div class="family-meta-row">
                <dt>Source</dt>
                <dd>
                  {m().importSource ?? m().chatSource ?? '—'}
                  <Show when={m().chatId}> ({m().chatId})</Show>
                </dd>
              </div>
              <div class="family-meta-row">
                <dt>Created</dt>
                <dd>{fmtDate(m().createdAt)}</dd>
              </div>
            </dl>
          )}
        </Show>
      </Show>
    </>
  );
}

function FamilyColumn(props: {
  label: string;
  familyId: string;
  familyName: string;
}) {
  const [stats] = createResource(
    () => props.familyId,
    (id) => api.getFamilyStats(id),
  );
  const [drill, setDrill] = createSignal<DrillCategory | null>(null);

  // A drilled-in list is keyed by category, not by family — switching the
  // family dropdown while drilled in would otherwise go on showing the
  // previous family's rows under the new family's heading (DrillPanel/its
  // list are only re-created when `drill()`'s value changes, not when
  // `familyId` does). Reset to the summary on any family switch instead.
  createEffect((prevFamilyId: string | undefined) => {
    const id = props.familyId;
    if (prevFamilyId !== undefined && id !== prevFamilyId) setDrill(null);
    return id;
  }, undefined);

  return (
    <div class="config-column">
      <h3>
        {props.label}: {props.familyName}
      </h3>
      <FamilyMetaBlock familyId={props.familyId} />
      <Show when={stats.error}>
        <div class="error-message">{(stats.error as Error).message}</div>
      </Show>
      <Show when={!stats.error}>
        <Show when={stats()} fallback={<p class="hint">Loading…</p>}>
          {(s: () => FamilyStats) => (
            <Show
              when={drill()}
              keyed
              fallback={<StatsTable stats={s()} onSelect={setDrill} />}
            >
              {(category) => (
                <>
                  <button
                    type="button"
                    class="btn-inline"
                    onClick={() => setDrill(null)}
                  >
                    ← Back to summary
                  </button>
                  <DrillPanel familyId={props.familyId} category={category} />
                </>
              )}
            </Show>
          )}
        </Show>
      </Show>
    </div>
  );
}

/**
 * "Build a golden" — hand-curate a `GoldenExpectation` from whichever of
 * Family A/B's already-persisted entities are actually correct, then score
 * both families' real (already-extracted) data against it directly
 * (`POST /families/:id/score-golden`, no live LLM re-run). This is the
 * answer to "is Haiku's extra granularity legitimate or noise" — a real
 * precision/recall/forbidden-hit verdict instead of a claim-count guess.
 */
const GOLDEN_CATEGORIES = [
  { kind: 'people', label: 'People' },
  { kind: 'places', label: 'Places' },
  { kind: 'relationships', label: 'Relationships' },
  { kind: 'stories', label: 'Stories' },
  { kind: 'events', label: 'Timeline events' },
  { kind: 'claims', label: 'Claims' },
] as const;
type GoldenCategory = (typeof GOLDEN_CATEGORIES)[number]['kind'];

type GoldenAddPayload =
  | { kind: 'people'; value: ExpectedPerson }
  | { kind: 'places'; value: ExpectedPlace }
  | { kind: 'relationships'; value: ExpectedRelationship }
  | { kind: 'stories'; value: ExpectedStory }
  | { kind: 'events'; value: ExpectedEvent }
  | { kind: 'claims'; value: ExpectedClaim };

/** A category row normalized for the golden editor's "pull from A/B" panels — the raw DB row plus what's needed to add or forbid it. */
interface GoldenSourceItem {
  key: string;
  label: string;
  detail: string;
  eventId?: string | null;
  eventIds?: string[];
  addPayload: GoldenAddPayload;
  /** Only set for people/places/events/claims — `ForbiddenExtractions` has no relationships/stories category. */
  forbidText?: string;
}

async function fetchGoldenSourceItems(
  familyId: string,
  category: GoldenCategory,
): Promise<GoldenSourceItem[]> {
  switch (category) {
    case 'people': {
      const rows = await api.getFamilyPeople(familyId);
      return rows.map((p) => ({
        key: p.id,
        label: p.name,
        detail: fmtLifespan(p.birthYear, p.deathYear),
        eventId: p.sourceEventId,
        addPayload: {
          kind: 'people',
          value: {
            name: p.name,
            birthYear: p.birthYear ?? undefined,
            deathYear: p.deathYear ?? undefined,
          },
        },
        forbidText: p.name,
      }));
    }
    case 'places': {
      const rows = await api.getFamilyPlaces(familyId);
      return rows.map((p) => ({
        key: p.id,
        label: p.name,
        detail: fmtLocation(p),
        eventId: p.sourceEventId,
        addPayload: {
          kind: 'places',
          value: {
            name: p.name,
            type: p.type ?? undefined,
            country: p.country ?? undefined,
          },
        },
        forbidText: p.name,
      }));
    }
    case 'relationships': {
      const rows = await api.getFamilyRelationships(familyId);
      return rows.map((r) => ({
        key: r.id,
        label: `${r.personAName ?? r.personAId} ↔ ${r.personBName ?? r.personBId}`,
        detail: r.relationshipType,
        eventId: r.sourceEventId,
        addPayload: {
          kind: 'relationships',
          value: {
            personA: r.personAName ?? r.personAId,
            personB: r.personBName ?? r.personBId,
            relationshipType: r.relationshipType,
          },
        },
      }));
    }
    case 'stories': {
      const rows = await api.getFamilyStories(familyId);
      return rows.map((s) => ({
        key: s.id,
        label: s.title ?? '(untitled)',
        detail: truncate(s.contentOriginal, 100),
        eventIds: s.sourceEventIds,
        addPayload: {
          kind: 'stories',
          value: {
            title: s.title ?? undefined,
            contentIncludes: s.contentOriginal,
          },
        },
      }));
    }
    case 'events': {
      const rows = await api.getFamilyTimelineEvents(familyId);
      return rows.map((e) => ({
        key: e.id,
        label: e.title,
        detail: fmtEventDate(e),
        eventId: e.sourceEventId,
        addPayload: {
          kind: 'events',
          value: {
            title: e.title,
            eventType: e.eventType ?? undefined,
            dateYear: e.dateYear ?? undefined,
          },
        },
        forbidText: e.title,
      }));
    }
    case 'claims': {
      const rows = await api.getFamilyClaims(familyId, { status: 'active' });
      return rows.map((c) => ({
        key: c.id,
        label: c.subject,
        detail: `${fmtValue(c.claimValue)} (${c.claimType})`,
        eventId: c.sourceEventId,
        addPayload: {
          kind: 'claims',
          value: {
            subject: c.subject,
            claimType: c.claimType,
            valueIncludes:
              typeof c.claimValue === 'string'
                ? c.claimValue
                : JSON.stringify(c.claimValue),
            attributedTo: c.attributedTo ?? undefined,
            claimedBySource: c.claimedBySource,
          },
        },
        forbidText: c.subject,
      }));
    }
  }
}

function appendRequired(
  golden: GoldenExpectation,
  payload: GoldenAddPayload,
): GoldenExpectation {
  switch (payload.kind) {
    case 'people':
      return {
        ...golden,
        requiredPeople: [...(golden.requiredPeople ?? []), payload.value],
      };
    case 'places':
      return {
        ...golden,
        requiredPlaces: [...(golden.requiredPlaces ?? []), payload.value],
      };
    case 'relationships':
      return {
        ...golden,
        requiredRelationships: [
          ...(golden.requiredRelationships ?? []),
          payload.value,
        ],
      };
    case 'stories':
      return {
        ...golden,
        requiredStories: [...(golden.requiredStories ?? []), payload.value],
      };
    case 'events':
      return {
        ...golden,
        requiredEvents: [...(golden.requiredEvents ?? []), payload.value],
      };
    case 'claims':
      return {
        ...golden,
        requiredClaims: [...(golden.requiredClaims ?? []), payload.value],
      };
  }
}

function removeRequiredAt(
  golden: GoldenExpectation,
  category: GoldenCategory,
  index: number,
): GoldenExpectation {
  switch (category) {
    case 'people':
      return {
        ...golden,
        requiredPeople: (golden.requiredPeople ?? []).filter(
          (_, i) => i !== index,
        ),
      };
    case 'places':
      return {
        ...golden,
        requiredPlaces: (golden.requiredPlaces ?? []).filter(
          (_, i) => i !== index,
        ),
      };
    case 'relationships':
      return {
        ...golden,
        requiredRelationships: (golden.requiredRelationships ?? []).filter(
          (_, i) => i !== index,
        ),
      };
    case 'stories':
      return {
        ...golden,
        requiredStories: (golden.requiredStories ?? []).filter(
          (_, i) => i !== index,
        ),
      };
    case 'events':
      return {
        ...golden,
        requiredEvents: (golden.requiredEvents ?? []).filter(
          (_, i) => i !== index,
        ),
      };
    case 'claims':
      return {
        ...golden,
        requiredClaims: (golden.requiredClaims ?? []).filter(
          (_, i) => i !== index,
        ),
      };
  }
}

type ForbiddableCategory = 'people' | 'places' | 'events' | 'claims';
const FORBIDDABLE_KEY: Record<
  ForbiddableCategory,
  'people' | 'places' | 'events' | 'claimSubjects'
> = {
  people: 'people',
  places: 'places',
  events: 'events',
  claims: 'claimSubjects',
};

function appendForbidden(
  golden: GoldenExpectation,
  category: ForbiddableCategory,
  text: string,
): GoldenExpectation {
  const key = FORBIDDABLE_KEY[category];
  const forbidden = golden.forbidden ?? {};
  return {
    ...golden,
    forbidden: { ...forbidden, [key]: [...(forbidden[key] ?? []), text] },
  };
}

function removeForbiddenAt(
  golden: GoldenExpectation,
  category: ForbiddableCategory,
  index: number,
): GoldenExpectation {
  const key = FORBIDDABLE_KEY[category];
  const forbidden = golden.forbidden ?? {};
  return {
    ...golden,
    forbidden: {
      ...forbidden,
      [key]: (forbidden[key] ?? []).filter((_, i) => i !== index),
    },
  };
}

function describeText(t: TextExpectation): string {
  return typeof t === 'string' ? t : t.anyOf.join(' | ');
}

function describeRequired(payload: GoldenAddPayload): string {
  switch (payload.kind) {
    case 'people': {
      const v = payload.value;
      const lifespan = fmtLifespan(v.birthYear ?? null, v.deathYear ?? null);
      return lifespan === '—'
        ? describeText(v.name)
        : `${describeText(v.name)} (${lifespan})`;
    }
    case 'places':
      return payload.value.country
        ? `${describeText(payload.value.name)}, ${describeText(payload.value.country)}`
        : describeText(payload.value.name);
    case 'relationships':
      return `${describeText(payload.value.personA)} ↔ ${describeText(payload.value.personB)}${
        payload.value.relationshipType
          ? ` (${payload.value.relationshipType})`
          : ''
      }`;
    case 'stories':
      return payload.value.title
        ? describeText(payload.value.title)
        : truncate(
            payload.value.contentIncludes
              ? describeText(payload.value.contentIncludes)
              : '(story)',
            80,
          );
    case 'events':
      return payload.value.dateYear
        ? `${describeText(payload.value.title)} (${payload.value.dateYear})`
        : describeText(payload.value.title);
    case 'claims':
      return `${describeText(payload.value.subject)}${
        payload.value.valueIncludes
          ? `: ${describeText(payload.value.valueIncludes)}`
          : ''
      }`;
  }
}

function requiredEntriesFor(
  golden: GoldenExpectation,
  category: GoldenCategory,
): GoldenAddPayload[] {
  switch (category) {
    case 'people':
      return (golden.requiredPeople ?? []).map((value) => ({
        kind: 'people',
        value,
      }));
    case 'places':
      return (golden.requiredPlaces ?? []).map((value) => ({
        kind: 'places',
        value,
      }));
    case 'relationships':
      return (golden.requiredRelationships ?? []).map((value) => ({
        kind: 'relationships',
        value,
      }));
    case 'stories':
      return (golden.requiredStories ?? []).map((value) => ({
        kind: 'stories',
        value,
      }));
    case 'events':
      return (golden.requiredEvents ?? []).map((value) => ({
        kind: 'events',
        value,
      }));
    case 'claims':
      return (golden.requiredClaims ?? []).map((value) => ({
        kind: 'claims',
        value,
      }));
  }
}

function manualAddPayload(
  category: GoldenCategory,
  text: string,
): GoldenAddPayload | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  switch (category) {
    case 'people':
      return { kind: 'people', value: { name: trimmed } };
    case 'places':
      return { kind: 'places', value: { name: trimmed } };
    case 'events':
      return { kind: 'events', value: { title: trimmed } };
    case 'claims':
      return { kind: 'claims', value: { subject: trimmed } };
    case 'stories':
      return { kind: 'stories', value: { contentIncludes: trimmed } };
    case 'relationships':
      // Needs personA/personB — not a single free-text field. Manual add is
      // pull-from-A/B only for this category.
      return null;
  }
}

/** Long families can have 300+ claims — filtered client-side (data's already fetched) and capped so the column stays scannable instead of one giant list. */
const GOLDEN_SOURCE_VISIBLE_CAP = 40;

function GoldenSourceColumn(props: {
  label: string;
  familyId: string;
  category: GoldenCategory;
  onAdd: (payload: GoldenAddPayload) => void;
  onForbid: ((text: string) => void) | undefined;
}) {
  const [items] = createResource(
    () => [props.familyId, props.category] as const,
    ([familyId, category]) => fetchGoldenSourceItems(familyId, category),
  );
  const [filter, setFilter] = createSignal('');
  const filtered = createMemo(() => {
    const q = filter().trim().toLowerCase();
    const all = items() ?? [];
    return q
      ? all.filter((item) =>
          `${item.label} ${item.detail}`.toLowerCase().includes(q),
        )
      : all;
  });
  return (
    <div class="golden-column">
      <h5>{props.label}</h5>
      <Show when={(items()?.length ?? 0) > GOLDEN_SOURCE_VISIBLE_CAP}>
        <input
          type="text"
          class="golden-filter"
          placeholder={`Filter ${items()?.length ?? 0} rows…`}
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
        />
      </Show>
      <Show when={items.error}>
        <div class="error-message">{(items.error as Error).message}</div>
      </Show>
      <Show when={!items.error}>
        <Show when={!items.loading} fallback={<p class="hint">Loading…</p>}>
          <Show
            when={filtered().length > 0}
            fallback={
              <p class="hint">{filter() ? 'No matches.' : 'Nothing here.'}</p>
            }
          >
            <ul class="golden-source-list">
              <Show when={filtered().length > GOLDEN_SOURCE_VISIBLE_CAP}>
                <li class="hint">
                  Showing first {GOLDEN_SOURCE_VISIBLE_CAP} of{' '}
                  {filtered().length} — filter to narrow down.
                </li>
              </Show>
              <For each={filtered().slice(0, GOLDEN_SOURCE_VISIBLE_CAP)}>
                {(item) => (
                  <li>
                    <div class="golden-item-label">
                      {item.label}
                      <Show when={item.detail}> — {item.detail}</Show>
                    </div>
                    <div class="golden-item-actions">
                      <button
                        type="button"
                        class="btn-inline"
                        onClick={() => props.onAdd(item.addPayload)}
                      >
                        + add to golden
                      </button>
                      <Show when={props.onForbid && item.forbidText}>
                        <button
                          type="button"
                          class="btn-inline btn-forbid"
                          onClick={() =>
                            props.onForbid?.(item.forbidText as string)
                          }
                        >
                          ✕ forbid
                        </button>
                      </Show>
                      <Show when={item.eventId}>
                        <TraceLink
                          familyId={props.familyId}
                          eventId={item.eventId}
                        />
                      </Show>
                      <For each={item.eventIds}>
                        {(eventId) => (
                          <TraceLink
                            familyId={props.familyId}
                            eventId={eventId}
                          />
                        )}
                      </For>
                    </div>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </Show>
    </div>
  );
}

function GoldenColumn(props: {
  golden: GoldenExpectation;
  category: GoldenCategory;
  onRemoveRequired: (index: number) => void;
  onRemoveForbidden: (index: number) => void;
  manualText: string;
  onManualTextChange: (text: string) => void;
  onManualAdd: () => void;
}) {
  const required = createMemo(() =>
    requiredEntriesFor(props.golden, props.category),
  );
  const forbiddable = createMemo<ForbiddableCategory | null>(() =>
    props.category === 'relationships' || props.category === 'stories'
      ? null
      : (props.category as ForbiddableCategory),
  );
  const forbiddenList = createMemo(() => {
    const cat = forbiddable();
    if (!cat) return [] as TextExpectation[];
    return props.golden.forbidden?.[FORBIDDABLE_KEY[cat]] ?? [];
  });
  const manualSupported = () => props.category !== 'relationships';

  return (
    <div class="golden-column golden-column-target">
      <h5>Golden</h5>
      <Show when={required().length === 0 && forbiddenList().length === 0}>
        <p class="hint">Nothing required or forbidden yet for this category.</p>
      </Show>
      <ul class="golden-target-list">
        <For each={required()}>
          {(payload, i) => (
            <li>
              <span class="category-tag">required</span>{' '}
              {describeRequired(payload)}
              <button
                type="button"
                class="btn-remove"
                onClick={() => props.onRemoveRequired(i())}
              >
                ✕
              </button>
            </li>
          )}
        </For>
        <For each={forbiddenList()}>
          {(text, i) => (
            <li>
              <span class="category-tag severity-warning-tag">forbidden</span>{' '}
              {describeText(text)}
              <button
                type="button"
                class="btn-remove"
                onClick={() => props.onRemoveForbidden(i())}
              >
                ✕
              </button>
            </li>
          )}
        </For>
      </ul>
      <Show
        when={manualSupported()}
        fallback={
          <p class="hint">
            Relationships need both people — pull one from A or B instead.
          </p>
        }
      >
        <div class="golden-manual-add">
          <input
            type="text"
            placeholder={
              props.category === 'stories'
                ? 'Paste a snippet the story must include…'
                : 'Add manually…'
            }
            value={props.manualText}
            onInput={(e) => props.onManualTextChange(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                props.onManualAdd();
              }
            }}
          />
          <button type="button" class="btn-inline" onClick={props.onManualAdd}>
            + add
          </button>
        </div>
      </Show>
    </div>
  );
}

function GoldenScoreCard(props: {
  label: string;
  familyName: string;
  familyId: string;
  golden: GoldenExpectation;
}) {
  const [score] = createResource(
    () => [props.familyId, JSON.stringify(props.golden)] as const,
    ([familyId]) => api.scoreFamilyAgainstGolden(familyId, props.golden),
  );
  return (
    <div class="golden-score-card">
      <h5>
        {props.label}: {props.familyName}
      </h5>
      <Show when={score.error}>
        <div class="error-message">{(score.error as Error).message}</div>
      </Show>
      <Show when={!score.error}>
        <Show when={score()} fallback={<p class="hint">Scoring…</p>}>
          {(s: () => FamilyGoldenScore) => (
            <>
              <div
                class="score-badge"
                classList={{ pass: s().passed, fail: !s().passed }}
              >
                score {s().score.toFixed(2)} · precision{' '}
                {s().precision.toFixed(2)} · recall {s().recall.toFixed(2)} ·{' '}
                {s().passed ? 'PASS' : 'FAIL'}
              </div>
              <Show when={s().forbiddenHits.length > 0}>
                <ul class="forbidden-hit-list">
                  <For each={s().forbiddenHits}>
                    {(hit) => (
                      <li class="forbidden-hit">
                        forbidden {hit.category}: "{hit.actual}" (matched golden
                        "{hit.expected}")
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <Show when={s().categories.some((c) => c.missing.length > 0)}>
                <ul class="missing-list">
                  <For each={s().categories}>
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
      </Show>
    </div>
  );
}

function GoldenEditor(props: {
  familyIdA: string;
  familyIdB: string;
  familyNameA: string;
  familyNameB: string;
}) {
  const [golden, setGolden] = createSignal<GoldenExpectation>({});
  const [hydrated, setHydrated] = createSignal(false);
  const [category, setCategory] = createSignal<GoldenCategory>('people');
  const [manualText, setManualText] = createSignal('');
  const [saveError, setSaveError] = createSignal<string | null>(null);

  // Reload the draft whenever the *pair* changes (not on every render) —
  // `on` so this doesn't also fire from `golden`'s own updates below.
  // `requestId` guards against a stale response: if the pair changes again
  // before this fetch resolves, its `.then` must not overwrite the newer
  // pair's state (which the persist effect below would then save over the
  // new pair's actual golden record).
  let requestId = 0;
  createEffect(
    on([() => props.familyIdA, () => props.familyIdB], ([a, b]) => {
      const thisRequestId = ++requestId;
      setHydrated(false);
      setGolden({});
      if (!a || !b) return;
      void api.getFamilyGolden(a, b).then((draft) => {
        if (thisRequestId !== requestId) return;
        setGolden(draft.golden ?? {});
        setHydrated(true);
      });
    }),
  );

  // Persist on every mutation, once the initial draft has loaded — gated on
  // `hydrated` so this can't fire with an empty `{}` before the real draft
  // arrives and clobber it.
  createEffect(
    on(golden, (g) => {
      if (!hydrated()) return;
      setSaveError(null);
      void api
        .saveFamilyGolden(props.familyIdA, props.familyIdB, g)
        .catch((err) => {
          setSaveError(
            err instanceof Error ? err.message : 'Failed to save golden draft',
          );
        });
    }),
  );

  const addToGolden = (payload: GoldenAddPayload) =>
    setGolden((g) => appendRequired(g, payload));
  const forbidInGolden = (cat: ForbiddableCategory) => (text: string) =>
    setGolden((g) => appendForbidden(g, cat, text));
  const removeRequired = (index: number) =>
    setGolden((g) => removeRequiredAt(g, category(), index));
  const removeForbidden = (index: number) =>
    setGolden((g) => {
      const cat = category();
      if (cat === 'relationships' || cat === 'stories') return g;
      return removeForbiddenAt(g, cat, index);
    });
  const manualAdd = () => {
    const payload = manualAddPayload(category(), manualText());
    if (!payload) return;
    addToGolden(payload);
    setManualText('');
  };

  const forbidHandler = createMemo<((text: string) => void) | undefined>(() => {
    const cat = category();
    return cat === 'relationships' || cat === 'stories'
      ? undefined
      : forbidInGolden(cat as ForbiddableCategory);
  });

  return (
    <section class="card golden-editor">
      <h3>Build a golden</h3>
      <p class="hint">
        Pull the extractions that are actually right from either family into
        "Golden", add anything neither model caught, and forbid the ones that
        are wrong. Both families get scored against it live —
        precision/recall/forbidden-hit numbers, not a claim-count guess.
        Grounding isn't checked here (it needs a live extraction's evidence
        span, which persisted rows don't keep).
      </p>
      <Show when={saveError()}>
        <div class="error-message">Draft not saved: {saveError()}</div>
      </Show>
      <div class="mode-tabs">
        <For each={GOLDEN_CATEGORIES}>
          {(c) => (
            <button
              type="button"
              classList={{ active: category() === c.kind }}
              onClick={() => setCategory(c.kind)}
            >
              {c.label}
            </button>
          )}
        </For>
      </div>
      <div class="golden-editor-grid">
        <GoldenSourceColumn
          label={`A: ${props.familyNameA}`}
          familyId={props.familyIdA}
          category={category()}
          onAdd={addToGolden}
          onForbid={forbidHandler()}
        />
        <GoldenSourceColumn
          label={`B: ${props.familyNameB}`}
          familyId={props.familyIdB}
          category={category()}
          onAdd={addToGolden}
          onForbid={forbidHandler()}
        />
        <GoldenColumn
          golden={golden()}
          category={category()}
          onRemoveRequired={removeRequired}
          onRemoveForbidden={removeForbidden}
          manualText={manualText()}
          onManualTextChange={setManualText}
          onManualAdd={manualAdd}
        />
      </div>
      <div class="golden-scores-grid">
        <GoldenScoreCard
          label="A"
          familyName={props.familyNameA}
          familyId={props.familyIdA}
          golden={golden()}
        />
        <GoldenScoreCard
          label="B"
          familyName={props.familyNameB}
          familyId={props.familyIdB}
          golden={golden()}
        />
      </div>
    </section>
  );
}

export function FamilyCompare() {
  const [families] = createResource(() => api.getFamilies());

  // `families.error` guarded first: reading `families()` once it has
  // errored re-throws, and `familyIdA`/`familyIdB` (module-scoped, so they
  // survive navigating away and back) can still be non-empty from a prior
  // visit even when this mount's fetch just failed.
  const nameFor = (id: string) =>
    (families.error ? undefined : families())?.find((f) => f.id === id)?.name ??
    '';

  return (
    <div class="page">
      <h2>Family Compare</h2>
      <p class="hint">
        Aggregate extraction counts for two already-persisted families, side by
        side — no Registrar re-run, no writes, just what's already in the
        canonical tables. Click a row to see the underlying records.
      </p>

      <section class="card">
        {/* Gated on `families()` resolving: a <select>'s `value` can only bind to an
            <option> already in the DOM, and a persisted (non-empty) familyIdA/B from a
            prior visit would otherwise render before that family's <option> exists,
            leaving the dropdown showing "Select a family…" despite a real selection. */}
        <Show when={families.error}>
          <div class="error-message">
            {families.error instanceof Error
              ? families.error.message
              : String(families.error)}
          </div>
        </Show>
        <Show when={!families.error}>
          <Show
            when={families()}
            fallback={<p class="hint">Loading families…</p>}
          >
            <div class="config-row">
              <label style={{ flex: 1 }}>
                Family A
                <select
                  value={familyIdA()}
                  onChange={(e) => setFamilyIdA(e.currentTarget.value)}
                >
                  <option value="">Select a family…</option>
                  <For each={families()}>
                    {(f) => <option value={f.id}>{f.name}</option>}
                  </For>
                </select>
              </label>
              <label style={{ flex: 1 }}>
                Family B
                <select
                  value={familyIdB()}
                  onChange={(e) => setFamilyIdB(e.currentTarget.value)}
                >
                  <option value="">Select a family…</option>
                  <For each={families()}>
                    {(f) => <option value={f.id}>{f.name}</option>}
                  </For>
                </select>
              </label>
            </div>
          </Show>
        </Show>
      </section>

      <Show when={familyIdA() && familyIdB()}>
        <InputMatchQueue familyIdA={familyIdA()} familyIdB={familyIdB()} />
        <GoldenEditor
          familyIdA={familyIdA()}
          familyIdB={familyIdB()}
          familyNameA={nameFor(familyIdA())}
          familyNameB={nameFor(familyIdB())}
        />
      </Show>

      <div class="results-grid">
        <Show
          when={familyIdA()}
          fallback={<p class="hint">Pick a family for column A.</p>}
        >
          <FamilyColumn
            label="A"
            familyId={familyIdA()}
            familyName={nameFor(familyIdA())}
          />
        </Show>
        <Show
          when={familyIdB()}
          fallback={<p class="hint">Pick a family for column B.</p>}
        >
          <FamilyColumn
            label="B"
            familyId={familyIdB()}
            familyName={nameFor(familyIdB())}
          />
        </Show>
      </div>
    </div>
  );
}
