export { EntityMatcherService, type MatchResult } from './entity-matcher';
export {
  ConflictDetectorService,
  type ConflictResult,
  type ConflictResolutionResult,
} from './conflict-detector';
export { MergeHandlerService } from './merge-handler';
export {
  StrengthCalculatorService,
  type StrengthResult,
  type StrengthFactors,
} from './strength-calculator';
export { InferenceEngineService, type InferredClaim } from './inference-engine';
export {
  type LlmClaimEvaluationRequest,
  type LlmClaimEvaluationResult,
  type LlmEntityMatchRequest,
  type LlmEntityMatchResult,
  LlmPrompts,
  blendScores,
} from './llm-evaluation';
