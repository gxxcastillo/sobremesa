import { reportConnectionOk, reportConnectionFailure } from './connection';

export interface ScenarioSummary {
  id: string;
  description: string;
  messageCount: number;
  contextMessageCount: number;
}

export interface FamilySummary {
  id: string;
  name: string;
  chatId: string | null;
}

export type ClaimType =
  | 'date'
  | 'location'
  | 'relationship'
  | 'detail'
  | 'identity';

export interface FamilyStats {
  people: number;
  places: number;
  relationships: number;
  stories: number;
  events: number;
  claimsActive: number;
  claimsByType: Partial<Record<ClaimType, number>>;
  claimConflicts: number;
  claimRelationshipsContradicts: number;
}

export interface FamilyMeta {
  name: string;
  chatSource: string | null;
  chatId: string | null;
  createdAt: string;
  defaultLanguage: string | null;
  timezone: string | null;
  importSource: string | null;
  messageCount: number;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
}

export interface FamilyEvent {
  id: string;
  conversationId: string;
  sequenceNumber: number;
  actorDisplayName: string | null;
  actorUsername: string | null;
  contentOriginal: string | null;
  occurredAt: string;
  eventType: string;
}

export interface FamilyPersonRow {
  id: string;
  name: string;
  aliases: string[];
  isPlaceholder: boolean | null;
  birthYear: number | null;
  deathYear: number | null;
  redacted: boolean;
  supersededBy: string | null;
  sourceEventId: string | null;
}

export interface FamilyPlaceRow {
  id: string;
  name: string;
  type: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  redacted: boolean;
  supersededBy: string | null;
  sourceEventId: string | null;
}

export interface FamilyRelationshipRow {
  id: string;
  personAId: string;
  personAName: string | null;
  personBId: string;
  personBName: string | null;
  relationshipType: string;
  category: string | null;
  status: string | null;
  qualifier: string | null;
  confidence: string | null;
  sourceEventId: string | null;
}

export interface FamilyStoryRow {
  id: string;
  title: string | null;
  contentOriginal: string;
  themes: string[] | null;
  timeframe: string | null;
  completeness: string | null;
  confidence: string | null;
  redacted: boolean;
  supersededBy: string | null;
  sourceEventIds: string[];
}

export interface FamilyTimelineEventRow {
  id: string;
  title: string;
  eventType: string | null;
  dateText: string | null;
  dateYear: number | null;
  descriptionOriginal: string | null;
  placeId: string | null;
  redacted: boolean;
  supersededBy: string | null;
  sourceEventId: string | null;
}

export interface FamilyClaimRow {
  id: string;
  claimType: ClaimType;
  subject: string;
  claimValue: unknown;
  confidence: string | null;
  status: string;
  claimedBy: string;
  claimedBySource: string;
  attributedTo: string | null;
  claimedAt: string;
  contextOriginal: string | null;
  sourceEventId: string | null;
}

export interface FamilyClaimConflictRow {
  claimId: string;
  claimSubject: string | null;
  claimValue: unknown;
  claimStatus: string | null;
  claimSourceEventId: string | null;
  conflictsWithClaimId: string;
  conflictsWithSubject: string | null;
  conflictsWithValue: unknown;
  conflictsWithStatus: string | null;
  conflictsWithSourceEventId: string | null;
  createdAt: string;
}

export interface FamilyClaimContradictionRow {
  claimId: string;
  claimSubject: string | null;
  claimValue: unknown;
  claimStatus: string | null;
  claimSourceEventId: string | null;
  relatedClaimId: string;
  relatedSubject: string | null;
  relatedValue: unknown;
  relatedStatus: string | null;
  relatedSourceEventId: string | null;
  createdAt: string;
}

/**
 * Mirrors `libs/evals`'s `TextExpectation`/`GoldenExpectation` shapes,
 * redeclared here for the same reason `ScenarioScore` etc. are above — the
 * frontend never imports `@sobremesa/evals` directly (Node-only server
 * code a Vite browser bundle can't resolve).
 */
export type TextExpectation = string | { anyOf: string[] };

export interface ExpectedPerson {
  name: TextExpectation;
  birthYear?: number;
  deathYear?: number;
}
export interface ExpectedPlace {
  name: TextExpectation;
  type?: string;
  country?: TextExpectation;
}
export interface ExpectedEvent {
  title: TextExpectation;
  eventType?: string;
  dateYear?: number;
}
export interface ExpectedRelationship {
  personA: TextExpectation;
  personB: TextExpectation;
  relationshipType?: string;
}
export interface ExpectedClaim {
  subject: TextExpectation;
  claimType?: string;
  valueIncludes?: TextExpectation;
  claimedBySource?: string;
  attributedTo?: TextExpectation;
}
export interface ExpectedStory {
  title?: TextExpectation;
  contentIncludes?: TextExpectation;
  themes?: TextExpectation[];
}
export interface ForbiddenExtractions {
  people?: TextExpectation[];
  places?: TextExpectation[];
  events?: TextExpectation[];
  claimSubjects?: TextExpectation[];
}
export interface GoldenExpectation {
  requiredPeople?: ExpectedPerson[];
  requiredPlaces?: ExpectedPlace[];
  requiredEvents?: ExpectedEvent[];
  requiredRelationships?: ExpectedRelationship[];
  requiredClaims?: ExpectedClaim[];
  requiredStories?: ExpectedStory[];
  forbidden?: ForbiddenExtractions;
}

export interface FamilyGolden {
  golden: GoldenExpectation;
  /** `null` when no draft has been saved for this family pair yet. */
  updatedAt: string | null;
}

export interface FamilyGoldenScore {
  score: number;
  precision: number;
  recall: number;
  passed: boolean;
  categories: CategoryScore[];
  forbiddenHits: Array<{ category: string; expected: string; actual: string }>;
}

export type Thoroughness = 'essential' | 'standard' | 'comprehensive';
export type Confidence = 'strict' | 'moderate' | 'lenient';
export type PrimaryLanguage = 'en' | 'es';

export interface ScribeConfigOverride {
  thoroughness?: Thoroughness;
  confidence?: Confidence;
  scribeName?: string;
  primaryLanguage?: PrimaryLanguage;
}

export interface ContextMessageOverride {
  senderName: string;
  text: string;
  occurredAt?: string;
}

export type RunInput =
  | { kind: 'scenario'; scenarioId: string }
  | { kind: 'adhoc'; text: string; senderName?: string }
  | {
      kind: 'real';
      familyId: string;
      eventId: string;
      contextWindow?: number;
      contextOverride?: ContextMessageOverride[];
      scribeConfig?: ScribeConfigOverride;
      systemPromptOverride?: string;
    };

export interface MessagePreviewMessage {
  senderName: string;
  text: string;
  occurredAt: string;
}

export interface MessagePreview {
  message: MessagePreviewMessage;
  context: MessagePreviewMessage[];
  contextWindow: number;
  systemPrompt: string;
  userMessage: string;
  scribeConfig: (ScribeConfigOverride & { culturalTerms: string[] }) | null;
  empty: boolean;
}

export interface RunConfig {
  provider: 'anthropic' | 'local' | 'lan';
  model: string;
}

export interface OllamaSourceStatus {
  baseUrl: string | null;
  models: string[];
}

export interface ProvidersInfo {
  anthropic: { configured: boolean };
  local: OllamaSourceStatus;
  lan: OllamaSourceStatus;
}

export interface CategoryScore {
  category: string;
  required: number;
  matchedRequired: number;
  actual: number;
  matchedActual: number;
  precision: number;
  recall: number;
  score: number;
  missing: string[];
}

/**
 * Mirrors `GROUNDING_FAILURE_GATE` in `libs/evals/src/lib/scorer.ts` — kept
 * as a duplicated literal rather than an import because the frontend never
 * depends on `@sobremesa/evals` directly (same reason `Thoroughness`/
 * `Confidence`/`ScenarioScore` etc. below are redeclared rather than
 * imported: that package pulls in Node-only server code that a Vite browser
 * bundle can't resolve).
 */
export const GROUNDING_FAILURE_GATE = 0.15;

export interface ScenarioScore {
  scenarioId: string;
  description: string;
  score: number;
  precision: number;
  recall: number;
  passed: boolean;
  hardFailed: boolean;
  categories: CategoryScore[];
  forbiddenHits: Array<{ category: string; expected: string; actual: string }>;
  grounding: {
    totalClaims: number;
    grounded: number;
    contextBleed: number;
    unmatched: number;
  };
  scored?: boolean;
}

export interface RecordedCall {
  request: {
    model: string;
    system?: string;
    messages: Array<{ role: string; content: unknown }>;
    temperature?: number;
    maxTokens: number;
    responseFormat?: unknown;
  };
  response?: {
    content: string;
    usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    model: string;
    stopReason?: string;
  };
  error?: string;
  startedAt: string;
  durationMs: number;
}

export interface CostEstimate {
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
}

export interface RunResultEntry {
  provider: string;
  model: string;
  // ScribeDomainModel, kept loose here — the UI only reads specific fields.
  outputs: Array<Record<string, unknown>>;
  error?: string;
  score?: ScenarioScore;
  llmCalls: RecordedCall[];
  /** null when `model` isn't in the local pricing table — render "—", not $0. */
  costEstimate: CostEstimate | null;
}

export interface QueueTrace {
  status: string;
  attempts: number;
  lastError: string | null;
  queuedAt: string;
  lockedAt: string | null;
  lockedBy: string | null;
  priority: number;
}

export interface ProcessingTrace {
  detectedLanguage: string | null;
  imageReferences: unknown;
  processingMetadata: Record<string, unknown> | null;
  processedAt: string;
  processedBy: string | null;
}

export interface EventLogEntry {
  id: string;
  createdAt: string;
  eventType: string;
  eventCategory: string;
  actor: string | null;
  actorType: string | null;
  eventData: Record<string, unknown> | null;
  severity: 'info' | 'warning' | 'error';
}

export interface MessageTraceResult {
  event: {
    id: string;
    conversationId: string;
    sequenceNumber: number | null;
    source: string;
    eventType: string;
    actorDisplayName: string | null;
    actorUsername: string | null;
    contentOriginal: string | null;
    languageOriginal: string | null;
    occurredAt: string;
    ingestedAt: string;
    externalReplyToId: string | null;
    ingestionBatchId: string | null;
  };
  queue: QueueTrace | null;
  processing: ProcessingTrace | null;
  /**
   * The latest `intern_evaluated` event_log entry for this event -- an
   * observed pipeline result, not a reviewable decision (no override
   * mechanism exists). `action`/`relevant` reflect `InternAgent.route()`'s
   * outcome; `null` when Intern never ran (e.g. filter-only debug configs).
   */
  intern: {
    action: 'ignore' | 'admin' | 'scribe' | 'historian';
    relevant: boolean | null;
    reason: string;
    language: string | null;
    method: 'deterministic' | 'model';
    model: string | null;
    tokensUsed: number | null;
    observedAt: string;
  } | null;
  eventLog: EventLogEntry[];
  redaction: { redactedAt: string; redactionReason: string } | null;
  produced: {
    claims: Array<{
      id: string;
      claimType: string;
      subject: string;
      claimValue: unknown;
      claimedBy: string;
      claimedBySource: string;
      attributedTo: string | null;
      confidence: string;
      status: string;
      claimedAt: string;
      analysis: {
        claimStrength: number | null;
        inferenceMethod: string | null;
        grounding: string | null;
      } | null;
      conflicts: Array<{
        claimId: string;
        subject: string | null;
        claimValue: unknown;
        claimedBy: string | null;
        status: string | null;
      }>;
    }>;
    relationships: Array<{
      id: string;
      relationshipType: string;
      category: string | null;
      personAName: string | null;
      personBName: string | null;
    }>;
    people: Array<{
      id: string;
      name: string;
      aliases: string[];
      isPlaceholder: boolean;
      birthYear: number | null;
      deathYear: number | null;
    }>;
    places: Array<{
      id: string;
      name: string;
      type: string | null;
      city: string | null;
      region: string | null;
      country: string | null;
    }>;
    merges: Array<{
      id: string;
      sourceEntityType: string;
      sourceEntityName: string | null;
      targetEntityType: string;
      targetEntityName: string | null;
      mergeStrategy: string | null;
      confidence: number | null;
      mergedBy: string | null;
      mergeReason: string | null;
    }>;
  };
}

export interface ImportVerificationRow {
  baselineEvent: FamilyEvent;
  candidateEvent: FamilyEvent | null;
  inputMatches: boolean;
  baselineActiveClaims: number;
  candidateActiveClaims: number;
  /** Latest observed `intern_evaluated` activity for the candidate event. */
  intern: {
    action: 'ignore' | 'admin' | 'scribe' | 'historian';
    relevant: boolean | null;
    reason: string;
    method: 'deterministic' | 'model';
  } | null;
}

export interface ImportVerificationReport {
  baseline: { id: string; name: string; eventCount: number };
  candidate: { id: string; name: string; eventCount: number };
  input: { matched: number; missing: number; mismatched: number };
  intern: {
    relevant: number;
    notRelevant: number;
    admin: number;
    missing: number;
  };
  rows: ImportVerificationRow[];
}

export interface Annotation {
  id: string;
  runId: string;
  target: unknown;
  verdict: 'good' | 'bad';
  note: string | null;
  createdAt: string;
}

export interface RunSummary {
  id: string;
  createdAt: string;
  input: RunInput;
  configs: RunConfig[];
}

export interface Run extends RunSummary {
  results: RunResultEntry[];
}

export interface RunWithAnnotations extends Run {
  annotations: Annotation[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
  } catch {
    // fetch() itself throwing (not a resolved !ok response) means the
    // backend never answered at all — connection refused, not just an
    // error. Surface that globally via `connection.ts` before rethrowing,
    // so every page/button gets the down-banner even if its own catch
    // block (if it has one) doesn't render anything.
    reportConnectionFailure();
    throw new Error(
      'Cannot reach the eval server — is `bun nx run eval:serve` running?',
    );
  }
  reportConnectionOk();
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  getScenarios: () => request<ScenarioSummary[]>('/scenarios'),
  getFamilies: () => request<FamilySummary[]>('/families'),
  getFamilyEvents: (
    familyId: string,
    limit = 50,
    options: { offset?: number; order?: 'recent' | 'sequence' } = {},
  ) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (options.offset) params.set('offset', String(options.offset));
    if (options.order) params.set('order', options.order);
    return request<FamilyEvent[]>(
      `/families/${familyId}/events?${params.toString()}`,
    );
  },
  /**
   * Pages through *all* of a family's events in insertion order
   * (`sequence_number` ascending, via `order: 'sequence'`) rather than the
   * single newest-N page `getFamilyEvents` returns — for Family Compare's
   * input-match check, where checking only the most recent page could miss a
   * mismatch earlier in the conversation. `maxTotal` bounds the number of
   * pages fetched for pathologically large families; `capped` says whether
   * that bound was hit before the family was exhausted.
   */
  async getAllFamilyEvents(
    familyId: string,
    maxTotal = 5000,
  ): Promise<{ events: FamilyEvent[]; capped: boolean }> {
    const pageSize = 500;
    const events: FamilyEvent[] = [];
    let offset = 0;
    while (events.length < maxTotal) {
      const page = await api.getFamilyEvents(familyId, pageSize, {
        offset,
        order: 'sequence',
      });
      events.push(...page);
      if (page.length < pageSize) return { events, capped: false };
      offset += pageSize;
    }
    return { events, capped: true };
  },
  getFamilyStats: (familyId: string) =>
    request<FamilyStats>(`/families/${familyId}/stats`),
  getFamilyMeta: (familyId: string) =>
    request<FamilyMeta>(`/families/${familyId}/meta`),
  getFamilyPeople: (familyId: string) =>
    request<FamilyPersonRow[]>(`/families/${familyId}/people`),
  getFamilyPlaces: (familyId: string) =>
    request<FamilyPlaceRow[]>(`/families/${familyId}/places`),
  getFamilyRelationships: (familyId: string) =>
    request<FamilyRelationshipRow[]>(`/families/${familyId}/relationships`),
  getFamilyStories: (familyId: string) =>
    request<FamilyStoryRow[]>(`/families/${familyId}/stories`),
  getFamilyTimelineEvents: (familyId: string) =>
    request<FamilyTimelineEventRow[]>(`/families/${familyId}/timeline-events`),
  getFamilyClaims: (
    familyId: string,
    options: { status?: string; type?: ClaimType } = {},
  ) => {
    const params = new URLSearchParams();
    if (options.status) params.set('status', options.status);
    if (options.type) params.set('type', options.type);
    const qs = params.toString();
    return request<FamilyClaimRow[]>(
      `/families/${familyId}/claims${qs ? `?${qs}` : ''}`,
    );
  },
  getFamilyClaimConflicts: (familyId: string) =>
    request<FamilyClaimConflictRow[]>(`/families/${familyId}/claim-conflicts`),
  getFamilyClaimContradictions: (familyId: string) =>
    request<FamilyClaimContradictionRow[]>(
      `/families/${familyId}/claim-contradictions`,
    ),
  getFamilyGolden: (familyIdA: string, familyIdB: string) =>
    request<FamilyGolden>(
      `/family-goldens?familyIdA=${encodeURIComponent(familyIdA)}&familyIdB=${encodeURIComponent(familyIdB)}`,
    ),
  saveFamilyGolden: (
    familyIdA: string,
    familyIdB: string,
    golden: GoldenExpectation,
  ) =>
    request<FamilyGolden>('/family-goldens', {
      method: 'PUT',
      body: JSON.stringify({ familyIdA, familyIdB, golden }),
    }),
  scoreFamilyAgainstGolden: (familyId: string, golden: GoldenExpectation) =>
    request<FamilyGoldenScore>(`/families/${familyId}/score-golden`, {
      method: 'POST',
      body: JSON.stringify({ golden }),
    }),
  getProviders: () => request<ProvidersInfo>('/providers'),
  getTrace: (familyId: string, eventIds: string[]) =>
    request<MessageTraceResult[]>(
      `/families/${familyId}/trace?eventIds=${eventIds.join(',')}`,
    ),
  getImportVerification: (
    baselineFamilyId: string,
    candidateFamilyId: string,
  ) =>
    request<ImportVerificationReport>(
      `/import-verification?baselineFamilyId=${encodeURIComponent(baselineFamilyId)}&candidateFamilyId=${encodeURIComponent(candidateFamilyId)}`,
    ),
  getMessagePreview: (
    familyId: string,
    eventId: string,
    options: {
      contextWindow?: number;
      thoroughness?: Thoroughness;
      confidence?: Confidence;
      scribeName?: string;
      primaryLanguage?: PrimaryLanguage;
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (options.contextWindow !== undefined)
      params.set('contextWindow', String(options.contextWindow));
    if (options.thoroughness) params.set('thoroughness', options.thoroughness);
    if (options.confidence) params.set('confidence', options.confidence);
    if (options.scribeName) params.set('scribeName', options.scribeName);
    if (options.primaryLanguage)
      params.set('primaryLanguage', options.primaryLanguage);
    const qs = params.toString();
    return request<MessagePreview>(
      `/families/${familyId}/events/${eventId}/preview${qs ? `?${qs}` : ''}`,
    );
  },
  createRun: (input: RunInput, configs: RunConfig[]) =>
    request<Run>('/runs', {
      method: 'POST',
      body: JSON.stringify({ input, configs }),
    }),
  listRuns: (
    options: { limit?: number; familyId?: string; eventIds?: string[] } = {},
  ) => {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.familyId) params.set('familyId', options.familyId);
    if (options.eventIds && options.eventIds.length > 0) {
      params.set('eventIds', options.eventIds.join(','));
    }
    return request<RunSummary[]>(`/runs?${params.toString()}`);
  },
  getRun: (id: string) => request<RunWithAnnotations>(`/runs/${id}`),
  annotate: (
    runId: string,
    target: unknown,
    verdict: 'good' | 'bad',
    note?: string,
  ) =>
    request<Annotation>(`/runs/${runId}/annotations`, {
      method: 'POST',
      body: JSON.stringify({ target, verdict, note }),
    }),
};
