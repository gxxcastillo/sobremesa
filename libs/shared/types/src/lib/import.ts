/**
 * Types for WhatsApp History Import feature.
 */

import type { LanguageCode } from './languages';

/**
 * A single parsed message from WhatsApp export.
 */
export interface ParsedMessage {
  /** Unique ID: wa-{timestamp_ms}-{line_index} */
  externalEventId: string;
  /** Original timestamp string for re-parsing with timezone */
  rawTimestamp: string;
  /** Parsed timestamp (initially with browser TZ, re-parsed with family TZ on server) */
  occurredAt: Date;
  /** Raw sender name from export */
  actorRawName: string;
  /** Cleaned sender name (removes ~ prefix etc.) */
  actorDisplayName: string;
  /** Type of event */
  eventType:
    | 'message'
    | 'photo'
    | 'video'
    | 'audio'
    | 'document'
    | 'sticker'
    | 'system';
  /** Message text or media placeholder */
  content: string;
  /** 1-based message number for deterministic ordering */
  messageNumber: number;
}

/**
 * Participant extracted from WhatsApp export.
 */
export interface ParsedParticipant {
  /** Raw name from export (e.g., "~ Gerie Najlis") */
  rawName: string;
  /** Auto-cleaned display name (e.g., "Gerie Najlis") */
  suggestedDisplayName: string;
  /** Number of messages from this participant */
  messageCount: number;
}

/**
 * Result of parsing a WhatsApp export file.
 */
export interface ParseResult {
  /** All parsed messages (stored in memory) */
  messages: ParsedMessage[];
  /** Aggregate statistics */
  stats: {
    messageCount: number;
    mediaCount: number;
    dateRange: { start: string; end: string };
    participantCount: number;
  };
  /** Detected languages across messages */
  detectedLanguages: LanguageCode[];
  /** Unique participants with message counts */
  participants: ParsedParticipant[];
}

/**
 * Configuration for a participant during import.
 */
export interface ParticipantConfig {
  rawName: string;
  displayName: string;
  timezone: string;
  role: 'admin' | 'member';
}

/**
 * Full import configuration from wizard.
 */
export interface ImportConfig {
  family: {
    name: string;
    defaultLanguage: LanguageCode;
    timezone: string;
  };
  participants: ParticipantConfig[];
}

/**
 * Token and cost estimate for import.
 */
export interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  /** What it would cost without batch discount */
  standardCost: number;
  /** Amount saved with batch discount */
  savings: number;
}

/**
 * Import job status.
 */
export type ImportJobStatus =
  | 'pending'
  | 'creating_family'
  | 'creating_identities'
  | 'submitting'
  | 'awaiting_intern' // Messages in DB, waiting for Intern
  | 'running_intern' // Intern processing messages
  | 'intern_complete' // Intern done, awaiting user review
  | 'processing_scribe' // Scribe Batch API in progress
  | 'processing' // Legacy, kept for backwards compatibility
  | 'hydrating'
  | 'complete'
  | 'failed'
  | 'cancelled';

/**
 * Import job progress for polling.
 */
export interface ImportStatus {
  jobId: string;
  status: ImportJobStatus;
  progress: {
    current: number;
    total: number;
    percentage: number;
  };
  /** Human-readable current stage */
  stage: string;
  /** Anthropic batch ID once submitted */
  batchId?: string;
  /** Created family ID */
  familyId?: string;
  /** Error message if failed */
  error?: string;
  startedAt: Date;
  completedAt?: Date;
  /** Intern review stats (when status is intern_complete) */
  internStats?: {
    toProcess: number;
    toSkip: number;
    overridden: number;
  };
}

/**
 * Intern's decision for a single message.
 */
export type InternDecisionType = 'process' | 'skip';

/**
 * Intern decision record.
 */
export interface InternDecision {
  id: string;
  importJobId: string;
  conversationEventId: string;
  decision: InternDecisionType;
  reason: string | null;
  overridden: boolean;
  originalDecision: InternDecisionType | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Message with Intern decision for UI display.
 */
export interface MessageWithDecision {
  /** Conversation event ID */
  id: string;
  /** Message timestamp */
  occurredAt: Date;
  /** Sender display name */
  actorDisplayName: string;
  /** Message content */
  content: string;
  /** Event type */
  eventType: string;
  /** Intern's current decision */
  decision: InternDecisionType;
  /** Reason for the decision */
  reason: string | null;
  /** Whether user overrode the decision */
  overridden: boolean;
}

/**
 * Message fingerprint for duplicate detection.
 * Minimal fields needed to check if a message already exists.
 */
export interface MessageFingerprint {
  /** Message timestamp */
  occurredAt: Date | string;
  /** Sender name (raw) */
  actorRawName: string;
  /** First 100 chars of content */
  contentPrefix: string;
}

/**
 * Result of duplicate check.
 */
export interface DuplicateCheckResult {
  /** Total messages checked */
  totalMessages: number;
  /** Messages that already exist in the database */
  alreadyExist: number;
  /** New messages that don't exist yet */
  newMessages: number;
  /** If duplicates found, which family they belong to */
  existingFamilyId?: string;
  /** If duplicates found, the family name */
  existingFamilyName?: string;
}

/**
 * Import job record stored in database.
 */
export interface ImportJob {
  id: string;
  createdBy: string;
  status: ImportJobStatus;
  source: 'whatsapp' | 'telegram' | 'other';
  config: ImportConfig;
  progress: {
    current: number;
    total: number;
    stage: string;
    lastProcessedEventId?: string;
  };
  batchIds: string[];
  familyId?: string;
  conversationId?: string;
  error?: string;
  startedAt: Date;
  completedAt?: Date;
  metadata: {
    rawFileContent?: string;
    messages?: ParsedMessage[]; // deprecated: use rawFileContent
  };
}
