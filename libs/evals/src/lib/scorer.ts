import { textMentionsName } from '@sobremesa/agents-registrar';
import type {
  ExtractedClaim,
  ExtractedEvent,
  ExtractedPerson,
  ExtractedPlace,
  ExtractedRelationship,
  ScribeDomainModel,
} from '@sobremesa/shared-types';
import type {
  CategoryScore,
  CapabilityGap,
  EvalReport,
  EvalSuiteReport,
  ExpectedClaim,
  ExpectedEvent,
  ExpectedPerson,
  ExpectedPlace,
  ExpectedRelationship,
  ExpectedStory,
  ForbiddenHit,
  GoldenExpectation,
  ScenarioRunResult,
  ScenarioScore,
  TextExpectation,
} from './scenario';

const EPSILON = 0.000001;

interface AggregatedOutput {
  people: ExtractedPerson[];
  places: ExtractedPlace[];
  events: ExtractedEvent[];
  relationships: ExtractedRelationship[];
  claims: ExtractedClaim[];
  stories: NonNullable<ScribeDomainModel['story']>[];
}

function aggregateOutputs(outputs: ScribeDomainModel[]): AggregatedOutput {
  return {
    people: outputs.flatMap((o) => o.people),
    places: outputs.flatMap((o) => o.places),
    events: outputs.flatMap((o) => o.events),
    relationships: outputs.flatMap((o) => o.relationships),
    claims: outputs.flatMap((o) => o.claims),
    stories: outputs.flatMap((o) => (o.story ? [o.story] : [])),
  };
}

function expectationOptions(expectation: TextExpectation): string[] {
  return typeof expectation === 'string' ? [expectation] : expectation.anyOf;
}

function describeExpectation(expectation: TextExpectation): string {
  return expectationOptions(expectation).join(' | ');
}

function normalized(text: string): string {
  return text.toLowerCase().normalize('NFC').trim();
}

function matchesText(
  actual: string | undefined,
  expected: TextExpectation,
): boolean {
  if (!actual) return false;
  const actualNorm = normalized(actual);

  return expectationOptions(expected).some((option) => {
    const expectedNorm = normalized(option);
    return (
      actualNorm.includes(expectedNorm) ||
      expectedNorm.includes(actualNorm) ||
      textMentionsName(actualNorm, expectedNorm, 2) ||
      textMentionsName(expectedNorm, actualNorm, 2)
    );
  });
}

function claimValueText(value: ExtractedClaim['claimValue']): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function fScore(precision: number, recall: number): number {
  if (precision + recall < EPSILON) return 0;
  return (2 * precision * recall) / (precision + recall);
}

function scoreCategory<TExpected, TActual>(options: {
  category: string;
  required: TExpected[];
  actual: TActual[];
  matches: (actual: TActual, expected: TExpected) => boolean;
  describeExpected: (expected: TExpected) => string;
}): CategoryScore {
  const matchedRequired = new Set<number>();
  const matchedActual = new Set<number>();

  options.actual.forEach((actual, actualIndex) => {
    const expectedIndex = options.required.findIndex(
      (expected, index) =>
        !matchedRequired.has(index) && options.matches(actual, expected),
    );
    if (expectedIndex !== -1) {
      matchedRequired.add(expectedIndex);
      matchedActual.add(actualIndex);
    }
  });

  const requiredCount = options.required.length;
  const actualCount = options.actual.length;
  const recall =
    requiredCount === 0
      ? actualCount === 0
        ? 1
        : 0
      : matchedRequired.size / requiredCount;
  const precision =
    actualCount === 0
      ? requiredCount === 0
        ? 1
        : 0
      : matchedActual.size / actualCount;

  return {
    category: options.category,
    required: requiredCount,
    matchedRequired: matchedRequired.size,
    actual: actualCount,
    matchedActual: matchedActual.size,
    precision,
    recall,
    score: fScore(precision, recall),
    missing: options.required
      .map((expected, index) =>
        matchedRequired.has(index)
          ? undefined
          : options.describeExpected(expected),
      )
      .filter((value): value is string => value !== undefined),
  };
}

function personMatches(
  actual: ExtractedPerson,
  expected: ExpectedPerson,
): boolean {
  if (!matchesText(actual.name, expected.name)) return false;
  if (
    expected.birthYear !== undefined &&
    actual.birthYear !== expected.birthYear
  ) {
    return false;
  }
  if (
    expected.deathYear !== undefined &&
    actual.deathYear !== expected.deathYear
  ) {
    return false;
  }
  return true;
}

function placeMatches(
  actual: ExtractedPlace,
  expected: ExpectedPlace,
): boolean {
  if (!matchesText(actual.name, expected.name)) return false;
  if (expected.type && actual.type !== expected.type) return false;
  if (expected.country && !matchesText(actual.country, expected.country))
    return false;
  return true;
}

function eventMatches(
  actual: ExtractedEvent,
  expected: ExpectedEvent,
): boolean {
  if (!matchesText(actual.title, expected.title)) return false;
  if (expected.eventType && actual.eventType !== expected.eventType)
    return false;
  if (
    expected.dateYear !== undefined &&
    actual.dateYear !== expected.dateYear
  ) {
    return false;
  }
  return true;
}

function relationshipMatches(
  actual: ExtractedRelationship,
  expected: ExpectedRelationship,
): boolean {
  const direct =
    matchesText(actual.personAName, expected.personA) &&
    matchesText(actual.personBName, expected.personB);
  const reverse =
    matchesText(actual.personAName, expected.personB) &&
    matchesText(actual.personBName, expected.personA);
  if (!direct && !reverse) return false;
  if (
    expected.relationshipType &&
    actual.relationshipType !== expected.relationshipType
  ) {
    return false;
  }
  return true;
}

function claimMatches(
  actual: ExtractedClaim,
  expected: ExpectedClaim,
): boolean {
  if (!matchesText(actual.subject, expected.subject)) return false;
  if (expected.claimType && actual.claimType !== expected.claimType)
    return false;
  if (
    expected.valueIncludes &&
    !matchesText(claimValueText(actual.claimValue), expected.valueIncludes)
  ) {
    return false;
  }
  if (
    expected.claimedBy &&
    !matchesText(actual.claimedBy, expected.claimedBy)
  ) {
    return false;
  }
  if (
    expected.claimedBySource &&
    actual.claimedBySource !== expected.claimedBySource
  ) {
    return false;
  }
  return true;
}

function storyMatches(
  actual: NonNullable<ScribeDomainModel['story']>,
  expected: ExpectedStory,
): boolean {
  if (expected.title && !matchesText(actual.title, expected.title))
    return false;
  if (
    expected.contentIncludes &&
    !matchesText(actual.content, expected.contentIncludes)
  ) {
    return false;
  }
  if (
    expected.themes?.some(
      (theme) =>
        !actual.themes.some((actualTheme) => matchesText(actualTheme, theme)),
    )
  ) {
    return false;
  }
  return true;
}

function forbiddenMatches(
  category: string,
  actualValues: string[],
  forbidden: TextExpectation[] | undefined,
): ForbiddenHit[] {
  if (!forbidden?.length) return [];

  return actualValues.flatMap((actual) =>
    forbidden
      .filter((expected) => matchesText(actual, expected))
      .map((expected) => ({
        category,
        expected: describeExpectation(expected),
        actual,
      })),
  );
}

function findForbiddenHits(
  output: AggregatedOutput,
  golden: GoldenExpectation,
): ForbiddenHit[] {
  const forbidden = golden.forbidden;
  if (!forbidden) return [];

  return [
    ...forbiddenMatches(
      'people',
      output.people.map((person) => person.name),
      forbidden.people,
    ),
    ...forbiddenMatches(
      'places',
      output.places.map((place) => place.name),
      forbidden.places,
    ),
    ...forbiddenMatches(
      'events',
      output.events.map((event) => event.title),
      forbidden.events,
    ),
    ...forbiddenMatches(
      'claimSubjects',
      output.claims.map((claim) => claim.subject),
      forbidden.claimSubjects,
    ),
  ];
}

export function scoreScenario(
  run: ScenarioRunResult,
  threshold: number,
): ScenarioScore {
  if (run.error) {
    return {
      scenarioId: run.scenario.id,
      description: run.scenario.description,
      score: 0,
      precision: 0,
      recall: 0,
      passed: false,
      hardFailed: true,
      categories: [],
      forbiddenHits: [
        {
          category: 'runtime',
          expected: 'successful Scribe run',
          actual: run.error.message,
        },
      ],
    };
  }

  const output = aggregateOutputs(run.outputs);
  const golden = run.scenario.golden;
  const categories = [
    scoreCategory({
      category: 'people',
      required: golden.requiredPeople ?? [],
      actual: output.people,
      matches: personMatches,
      describeExpected: (expected) => describeExpectation(expected.name),
    }),
    scoreCategory({
      category: 'places',
      required: golden.requiredPlaces ?? [],
      actual: output.places,
      matches: placeMatches,
      describeExpected: (expected) => describeExpectation(expected.name),
    }),
    scoreCategory({
      category: 'events',
      required: golden.requiredEvents ?? [],
      actual: output.events,
      matches: eventMatches,
      describeExpected: (expected) => describeExpectation(expected.title),
    }),
    scoreCategory({
      category: 'relationships',
      required: golden.requiredRelationships ?? [],
      actual: output.relationships,
      matches: relationshipMatches,
      describeExpected: (expected) =>
        `${describeExpectation(expected.personA)} -> ${describeExpectation(expected.personB)}`,
    }),
    scoreCategory({
      category: 'claims',
      required: golden.requiredClaims ?? [],
      actual: output.claims,
      matches: claimMatches,
      describeExpected: (expected) => describeExpectation(expected.subject),
    }),
    scoreCategory({
      category: 'stories',
      required: golden.requiredStories ?? [],
      actual: output.stories,
      matches: storyMatches,
      describeExpected: (expected) =>
        expected.title
          ? describeExpectation(expected.title)
          : describeExpectation(expected.contentIncludes ?? 'story'),
    }),
  ].filter((category) => category.required > 0);

  const forbiddenHits = findForbiddenHits(output, golden);
  const hardFailed = forbiddenHits.length > 0;
  const precision = average(categories.map((category) => category.precision));
  const recall = average(categories.map((category) => category.recall));
  const score = hardFailed
    ? 0
    : average(categories.map((category) => category.score));

  return {
    scenarioId: run.scenario.id,
    description: run.scenario.description,
    score,
    precision,
    recall,
    passed: !hardFailed && score >= threshold,
    hardFailed,
    categories,
    forbiddenHits,
  };
}

export function buildReport(options: {
  results: ScenarioRunResult[];
  provider: string;
  model: string;
  threshold: number;
}): EvalReport {
  const scenarioScores = options.results.map((result) =>
    scoreScenario(result, options.threshold),
  );
  const aggregateScore = average(scenarioScores.map((score) => score.score));
  const aggregatePrecision = average(
    scenarioScores.map((score) => score.precision),
  );
  const aggregateRecall = average(scenarioScores.map((score) => score.recall));

  return {
    generatedAt: new Date(),
    provider: options.provider,
    model: options.model,
    threshold: options.threshold,
    aggregateScore,
    aggregatePrecision,
    aggregateRecall,
    passed:
      aggregateScore >= options.threshold &&
      scenarioScores.every((score) => !score.hardFailed),
    scenarioScores,
  };
}

export function buildSuiteReport(options: {
  reports: EvalReport[];
  threshold: number;
  baselineProvider?: string;
  candidateProvider?: string;
}): EvalSuiteReport {
  const baselineProvider = options.baselineProvider ?? 'anthropic';
  const baselineReport =
    options.reports.find((report) => report.provider === baselineProvider) ??
    options.reports[0];
  const candidateReport =
    options.candidateProvider !== undefined
      ? options.reports.find(
          (report) => report.provider === options.candidateProvider,
        )
      : options.reports.find(
          (report) => report.provider !== baselineReport?.provider,
        );

  const capabilityGaps =
    baselineReport && candidateReport
      ? calculateCapabilityGaps(baselineReport, candidateReport)
      : [];
  const aggregateCapabilityGap =
    baselineReport && candidateReport
      ? baselineReport.aggregateScore - candidateReport.aggregateScore
      : undefined;

  return {
    generatedAt: new Date(),
    threshold: options.threshold,
    baselineProvider: baselineReport?.provider ?? baselineProvider,
    reports: options.reports,
    providerColumns: options.reports.map((report) => ({
      provider: report.provider,
      model: report.model,
      aggregateScore: report.aggregateScore,
      aggregatePrecision: report.aggregatePrecision,
      aggregateRecall: report.aggregateRecall,
      passed: report.passed,
    })),
    capabilityGaps,
    aggregateCapabilityGap,
    passed: options.reports.every((report) => report.passed),
  };
}

function calculateCapabilityGaps(
  baselineReport: EvalReport,
  candidateReport: EvalReport,
): CapabilityGap[] {
  const candidateByScenario = new Map(
    candidateReport.scenarioScores.map((score) => [score.scenarioId, score]),
  );

  return baselineReport.scenarioScores.flatMap((baselineScore) => {
    const candidateScore = candidateByScenario.get(baselineScore.scenarioId);
    if (!candidateScore) return [];

    return {
      scenarioId: baselineScore.scenarioId,
      baselineProvider: baselineReport.provider,
      candidateProvider: candidateReport.provider,
      baselineScore: baselineScore.score,
      candidateScore: candidateScore.score,
      gap: baselineScore.score - candidateScore.score,
    };
  });
}

function average(values: number[]): number {
  if (values.length === 0) return 1;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
