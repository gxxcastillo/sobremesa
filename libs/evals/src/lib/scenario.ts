import type {
  ClaimSourceType,
  ScribeDomainModel,
} from '@sobremesa/shared-types';

/**
 * Default recent-message window a scenario run supplies to Scribe, shared by
 * the runner (context construction) and the scorer (grounding must consult
 * exactly the context the model saw — no more, no less).
 */
export const DEFAULT_CONTEXT_WINDOW = 30;

export type TextExpectation = string | { anyOf: string[] };

export interface EvalSender {
  id: string;
  displayName: string;
  username?: string;
}

export interface EvalMessage {
  sender: string;
  text: string;
  replyTo?: number;
  answeredQuestion?: {
    content: string;
    askedByName?: string;
  };
  occurredAt?: Date;
}

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
  claimedBySource?: ClaimSourceType;
  /** Who the speaker attributes this claim to (attributed/hearsay claims only — see ExtractedClaim.attributedTo) */
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

export interface ScribeEvalScenario {
  id: string;
  description: string;
  senders: Record<string, EvalSender>;
  /** Prior messages available as context but not scored as current-message extractions. */
  initialContext?: EvalMessage[];
  messages: EvalMessage[];
  contextWindow?: number;
  familyConfig?: {
    timezone?: string;
    culturalTerms?: string[];
  };
  golden: GoldenExpectation;
}

export interface ScenarioRunResult {
  scenario: ScribeEvalScenario;
  outputs: ScribeDomainModel[];
  error?: Error;
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

export interface ForbiddenHit {
  category: string;
  expected: string;
  actual: string;
}

/**
 * Per-scenario evidence-grounding tallies (provenance plan #3). Mirrors the
 * Registrar's deterministic check: context-bleed claims are excluded from
 * scoring because the pipeline rejects them before persistence; unmatched
 * claims stay (the pipeline keeps them, flagged).
 */
export interface GroundingSummary {
  totalClaims: number;
  grounded: number;
  contextBleed: number;
  unmatched: number;
}

export interface ScenarioScore {
  scenarioId: string;
  description: string;
  score: number;
  precision: number;
  recall: number;
  passed: boolean;
  hardFailed: boolean;
  categories: CategoryScore[];
  forbiddenHits: ForbiddenHit[];
  grounding: GroundingSummary;
}

export interface EvalReport {
  generatedAt: Date;
  provider: string;
  model: string;
  threshold: number;
  aggregateScore: number;
  aggregatePrecision: number;
  aggregateRecall: number;
  /** Fraction of extracted claims whose evidence did not ground in the current message (context-bleed + unmatched). 0 when no claims. */
  groundingFailureRate: number;
  passed: boolean;
  scenarioScores: ScenarioScore[];
}

export interface ProviderScoreColumn {
  provider: string;
  model: string;
  aggregateScore: number;
  aggregatePrecision: number;
  aggregateRecall: number;
  passed: boolean;
}

export interface CapabilityGap {
  scenarioId: string;
  baselineProvider: string;
  candidateProvider: string;
  baselineScore: number;
  candidateScore: number;
  gap: number;
}

export interface EvalSuiteReport {
  generatedAt: Date;
  threshold: number;
  baselineProvider: string;
  reports: EvalReport[];
  providerColumns: ProviderScoreColumn[];
  capabilityGaps: CapabilityGap[];
  aggregateCapabilityGap?: number;
  passed: boolean;
}

/**
 * Filter `all` down to the requested `ids` (returned in `all`'s original
 * order, not `ids`' order), or return everything when no ids are requested.
 * Throws if any requested id doesn't match a scenario. Shared by both eval
 * runners so `--scenario` selection/error behavior stays identical across
 * `scribe-evals` and `pipeline-snapshots`.
 */
export function selectScenarios<T extends { id: string }>(
  all: T[],
  ids: string[],
): T[] {
  if (ids.length === 0) {
    return all;
  }

  const selected = all.filter((scenario) => ids.includes(scenario.id));
  const selectedIds = new Set(selected.map((scenario) => scenario.id));
  const missing = ids.filter((id) => !selectedIds.has(id));
  if (missing.length > 0) {
    throw new Error(`Unknown scenario(s): ${missing.join(', ')}`);
  }
  return selected;
}
