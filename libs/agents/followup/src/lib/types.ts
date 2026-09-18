import type { GeneratedQuestion } from '@sobremesa/shared-types';

/**
 * Result of `FollowupAgent.formulate()`. Never throws: a provider error, an
 * unparseable response, or a failed grounding guard all come back as
 * `ask: false` with `reason` explaining why, exactly like the model
 * declining on its own.
 */
export interface FollowupResult {
  ask: boolean;
  /** Present when `ask` is true. `origin` is always `'followup'`, ready to
   * hand to `QuestionRepository.createFromGenerated`. */
  question?: GeneratedQuestion;
  /** The model's one-sentence reason, or an explanation of why this call
   * counts as a decline (unparseable response, ungrounded name, ...). */
  reason: string;
  /** Every person, place or event the question named. Empty when `ask` is
   * false. */
  namesUsed: string[];
}

/**
 * The family record on the people, places and events named in one message,
 * formatted for the formulation prompt.
 */
export interface RecordContext {
  block: string;
  hints: string[];
}
