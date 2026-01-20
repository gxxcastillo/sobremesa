/**
 * Types for integrity checkpointing and tamper detection.
 */

/**
 * Supported blockchain networks for checkpoint anchoring.
 */
export type BlockchainNetwork = 'solana' | 'ethereum' | 'polygon' | string;

/**
 * Type of data being checkpointed.
 */
export type CheckpointType = 'event_log' | 'conversation_events';

/**
 * An integrity checkpoint for tamper detection.
 * Stores a cryptographic hash of events in a time range.
 * Can be anchored on-chain for verifiable timestamps.
 */
export interface IntegrityCheckpoint {
  id: string;
  familyId: string;

  /** Type of data being checkpointed */
  checkpointType: CheckpointType;

  /** Start of time range (inclusive) */
  rangeStart?: Date;

  /** End of time range (inclusive) */
  rangeEnd?: Date;

  /** HMAC-SHA256 hash of concatenated event hashes */
  checkpointHash: string;

  /** Blockchain network if anchored on-chain */
  chain?: BlockchainNetwork;

  /** Transaction hash on blockchain */
  txHash?: string;

  createdAt: Date;
}
