export {
  RegistrarAgent,
  type RegistrarAgentOptions,
  type PersistResult,
} from './lib/registrar';
export {
  detectClaimConflict,
  subjectsMatch,
  canClaimTypeConflict,
} from './lib/conflict-detector';
export { textMentionsName, wordTokens } from './lib/name-match';
export {
  createGrounder,
  groundEvidence,
  normalizeForGrounding,
  type Grounder,
  type GroundingVerdict,
} from './lib/grounding';
