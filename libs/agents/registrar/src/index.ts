export {
  RegistrarAgent,
  type RegistrarAgentOptions,
  type PersistResult,
} from './lib/registrar';
export {
  detectClaimConflict,
  isExactDuplicateClaim,
  subjectsMatch,
  canClaimTypeConflict,
} from './lib/conflict-detector';
export {
  createGrounder,
  groundEvidence,
  normalizeForGrounding,
  type Grounder,
  type GroundingVerdict,
} from './lib/grounding';
