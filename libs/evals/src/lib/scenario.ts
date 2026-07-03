import type {
  ClaimSourceType,
  ScribeDomainModel,
} from '@sobremesa/shared-types';

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
  claimedBy?: TextExpectation;
  claimedBySource?: ClaimSourceType;
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
}

export interface EvalReport {
  generatedAt: Date;
  provider: string;
  model: string;
  threshold: number;
  aggregateScore: number;
  aggregatePrecision: number;
  aggregateRecall: number;
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
