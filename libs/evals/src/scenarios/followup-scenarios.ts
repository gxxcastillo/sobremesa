import type { SupportedLanguage } from '@sobremesa/shared-types';

/**
 * Story-followups-plan.md #7: the decision/generation scenarios for
 * `FollowupAgent.formulate()` -- malformed/provider-error outcomes and the
 * deterministic grounding guard, including its known blind spot. All text is
 * invented/paraphrased, never real family messages (eval-multi-stage-
 * fixtures-plan.md's default).
 */
export interface FollowupFormulationScenario {
  id: string;
  description: string;
  messageText: string;
  detectedLanguage?: SupportedLanguage;
  /** What `RecordContextBuilder.build()` would have returned for this message. */
  recordBlock: string;
  hints?: string[];
  /** The raw provider turn: either response text, or a thrown call failure. */
  provider: { content: string } | { throws: string };
  expected: {
    ask: boolean;
    reasonIncludes?: string;
    namesUsed?: string[];
    questionContains?: string;
  };
  /**
   * Set only on a scenario that pins a known, accepted gap in the guard
   * rather than a bug -- explains why the expected outcome looks wrong at a
   * glance.
   */
  knownLimitation?: string;
}

export const followupFormulationScenarios: FollowupFormulationScenario[] = [
  {
    id: 'asks-with-grounded-place',
    description:
      'A place named in the message and echoed in names_used is accepted.',
    messageText:
      'We went to Pochomil beach with the whole family years ago, it was such a good time.',
    recordBlock:
      '(nothing else recorded about people/places/events named here)',
    provider: {
      content: JSON.stringify({
        ask: true,
        question: 'Who did you usually go to Pochomil with?',
        names_used: ['Pochomil'],
        story_context: 'Childhood trips to Pochomil.',
        reason: 'A place from the family past worth a story.',
      }),
    },
    expected: {
      ask: true,
      namesUsed: ['Pochomil'],
      questionContains: 'Pochomil',
    },
  },
  {
    id: 'declines-routine-logistics',
    description:
      'The model declines on routine logistics; not treated as a failure.',
    messageText: "I'll pick up the kids at 5, don't wait on me for dinner.",
    recordBlock:
      '(nothing else recorded about people/places/events named here)',
    provider: {
      content: JSON.stringify({
        ask: false,
        question: '',
        names_used: [],
        story_context: '',
        reason: 'Routine logistics, nothing to invite.',
      }),
    },
    expected: { ask: false, reasonIncludes: 'logistics' },
  },
  {
    id: 'malformed-json-response',
    description: 'A non-JSON response declines cleanly instead of throwing.',
    messageText: 'Just checking in, how is everyone doing today?',
    recordBlock:
      '(nothing else recorded about people/places/events named here)',
    provider: { content: "Sorry, I can't help with that." },
    expected: { ask: false, reasonIncludes: 'unparseable' },
  },
  {
    id: 'schema-invalid-response',
    description:
      'Valid JSON missing required fields declines cleanly, through the same ' +
      "catch path as malformed JSON -- both surface as 'unparseable response'.",
    messageText: 'Just checking in, how is everyone doing today?',
    recordBlock:
      '(nothing else recorded about people/places/events named here)',
    provider: { content: JSON.stringify({ ask: true }) },
    expected: { ask: false, reasonIncludes: 'unparseable' },
  },
  {
    id: 'provider-call-fails',
    description:
      'A thrown provider error declines cleanly instead of propagating.',
    messageText: 'Just checking in, how is everyone doing today?',
    recordBlock:
      '(nothing else recorded about people/places/events named here)',
    provider: { throws: 'network timeout' },
    expected: { ask: false, reasonIncludes: 'formulation call failed' },
  },
  {
    id: 'ask-true-empty-question-text',
    description: 'ask=true with blank question text is treated as a decline.',
    messageText: 'Grandma made her famous tamales for the whole gathering.',
    recordBlock:
      '(nothing else recorded about people/places/events named here)',
    provider: {
      content: JSON.stringify({
        ask: true,
        question: '   ',
        names_used: [],
        story_context: '',
        reason: 'Worth asking about.',
      }),
    },
    expected: { ask: false, reasonIncludes: 'empty question text' },
  },
  {
    id: 'ungrounded-name-hallucinated',
    description:
      'names_used cites a person never shown to the model; the grounding guard declines.',
    messageText: 'Grandma made her famous tamales for the whole gathering.',
    recordBlock:
      '(nothing else recorded about people/places/events named here)',
    provider: {
      content: JSON.stringify({
        ask: true,
        question: 'Did Lucia help Grandma make the tamales?',
        names_used: ['Lucia'],
        story_context: '',
        reason: 'A family recipe worth asking about.',
      }),
    },
    expected: { ask: false, reasonIncludes: 'not shown to the model' },
  },
  {
    id: 'known-names-invented-relationship',
    description:
      'names_used cites only real, shown names, but the question asserts a ' +
      'relationship between them that was never stated -- the guard has no way ' +
      'to catch this.',
    messageText:
      'Uncle Mario and Rosa spent the whole afternoon telling stories about the old house.',
    recordBlock:
      '(nothing else recorded about people/places/events named here)',
    provider: {
      content: JSON.stringify({
        ask: true,
        question: "Mario, what was it like being Rosa's grandfather?",
        names_used: ['Mario', 'Rosa'],
        story_context: '',
        reason: 'A warm memory worth asking about.',
      }),
    },
    expected: { ask: true, namesUsed: ['Mario', 'Rosa'] },
    knownLimitation:
      "The grounding guard only checks that names_used's entries were shown to " +
      'the model (textMentionsName against the prompt) -- it has no mechanism to ' +
      'verify a relationship the question text asserts between two real names. ' +
      "Nothing here was ever said about Mario being Rosa's grandfather. This " +
      "scenario pins today's behavior (the question still goes out) so that " +
      'tightening the guard later is a deliberate, visible diff against this ' +
      'test, not a silent regression discovered after the fact. Distinguishes ' +
      'deterministic validation (what this guard does) from factual judgment ' +
      '(what it cannot do) -- a passing mock test here is not evidence of model ' +
      'quality.',
  },
];

/**
 * Story-followups-plan.md #7: the activation/pacing scenarios for
 * `FacilitatorAgent.askNextQuestion()` -- #6a (pause), #6b (superseded by
 * activity), D3 (expiry), the 24h/one-at-a-time throttle, and the verbatim
 * no-warmth send. Every "minutes ago" is relative to the runner's own call
 * time (mirrors facilitator.spec.ts's existing `Date.now() - minutes * 60_000`
 * convention; `FacilitatorAgent` reads the real clock directly).
 */
export interface FacilitatorActivationScenario {
  id: string;
  description: string;
  paused?: boolean;
  minMinutesBetweenQuestions?: number;
  lastAskedMinutesAgo?: number;
  lastConversationEventMinutesAgo?: number;
  providerConfigured?: boolean;
  pendingQuestion?: {
    contentOriginal: string;
    createdAtMinutesAgo: number;
    /** When set, the fake expiry index treats this question as already expired. */
    expired?: boolean;
  };
  expected: {
    success: boolean;
    sent: boolean;
    skippedReasonIncludes?: string;
    retiredReason?: 'expired' | 'superseded_by_activity';
    /** Asserted when `sent` is true: the exact outbound text. */
    sentTextEquals?: string;
    /** Asserted when `sent` is true: the real provider must never be called (verbatim exception). */
    providerCalled?: boolean;
  };
}

export const facilitatorActivationScenarios: FacilitatorActivationScenario[] = [
  {
    id: 'sends-verbatim-once-quiet-and-due',
    description:
      'A due follow-up question is sent verbatim once the chat has been quiet ' +
      'since before it was proposed.',
    lastConversationEventMinutesAgo: 50,
    pendingQuestion: {
      contentOriginal: 'What was Pochomil like back then?',
      createdAtMinutesAgo: 40,
    },
    expected: {
      success: true,
      sent: true,
      sentTextEquals: 'What was Pochomil like back then?',
      providerCalled: false,
    },
  },
  {
    id: 'still-waiting-for-quiet',
    description:
      'Fewer than 30 minutes of quiet since the last message: not sent yet.',
    lastConversationEventMinutesAgo: 10,
    pendingQuestion: {
      contentOriginal: 'What was Pochomil like back then?',
      createdAtMinutesAgo: 5,
    },
    expected: {
      success: true,
      sent: false,
      skippedReasonIncludes: 'minutes of quiet',
    },
  },
  {
    id: 'cancelled-by-later-activity',
    description:
      "#6b: the chat is quiet now, but it wasn't quiet the whole wait -- someone " +
      'talked after the question was proposed, so it is retired outright rather ' +
      'than sent once things settle again.',
    lastConversationEventMinutesAgo: 35,
    pendingQuestion: {
      contentOriginal: 'What was Pochomil like back then?',
      createdAtMinutesAgo: 50,
    },
    expected: {
      success: true,
      sent: false,
      skippedReasonIncludes: 'superseded by chat activity',
      retiredReason: 'superseded_by_activity',
    },
  },
  {
    id: 'expired-before-becoming-due',
    description:
      'D3: a question that sat unasked past its 24h expiry is retired as cleanup ' +
      'and never reaches the send path -- findPending already excludes it, so ' +
      "the result is simply 'no pending questions'.",
    lastConversationEventMinutesAgo: 50,
    pendingQuestion: {
      contentOriginal: 'What was Pochomil like back then?',
      createdAtMinutesAgo: 2000,
      expired: true,
    },
    expected: {
      success: true,
      sent: false,
      skippedReasonIncludes: 'No pending questions',
      retiredReason: 'expired',
    },
  },
  {
    id: 'paused-family-suppresses-send',
    description:
      '#6a: a paused family gets no unprompted send even with a due, otherwise' +
      '-eligible follow-up waiting.',
    paused: true,
    lastConversationEventMinutesAgo: 50,
    pendingQuestion: {
      contentOriginal: 'What was Pochomil like back then?',
      createdAtMinutesAgo: 40,
    },
    expected: {
      success: true,
      sent: false,
      skippedReasonIncludes: 'paused',
    },
  },
  {
    id: 'throttled-by-recent-ask',
    description:
      'Another question was asked inside the throttle window; the due follow-up ' +
      'waits even though it is otherwise eligible.',
    lastAskedMinutesAgo: 10,
    minMinutesBetweenQuestions: 60,
    lastConversationEventMinutesAgo: 50,
    pendingQuestion: {
      contentOriginal: 'What was Pochomil like back then?',
      createdAtMinutesAgo: 40,
    },
    expected: {
      success: true,
      sent: false,
      skippedReasonIncludes: 'asked within last',
    },
  },
  {
    id: 'sent-verbatim-ignores-configured-provider',
    description:
      'Even with an AI provider configured, a follow-up-origin question is sent ' +
      'exactly as written -- the warmth formula never applies to it.',
    providerConfigured: true,
    lastConversationEventMinutesAgo: 50,
    pendingQuestion: {
      contentOriginal: 'What was Pochomil like back then?',
      createdAtMinutesAgo: 40,
    },
    expected: {
      success: true,
      sent: true,
      sentTextEquals: 'What was Pochomil like back then?',
      providerCalled: false,
    },
  },
];
