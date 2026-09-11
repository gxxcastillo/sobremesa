/**
 * Types for the chat history import feature. The shapes below (ParsedMessage,
 * ParseResult, etc.) are format-agnostic by design; WhatsApp is the only
 * source with a parser implemented today (`libs/import-utils`), but
 * `ImportSource` already reserves room for others.
 */

import type { LanguageCode } from './languages';

/**
 * A single parsed message from a chat export.
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
 * Participant extracted from a chat export.
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
 * Result of parsing a chat export file.
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
 * Import job status. Every ingress (Studio import, CLI import, live chat)
 * runs events through the same immediate Intern -> Scribe -> Registrar
 * pipeline with no pre-extraction review checkpoint -- see
 * `.agents/plans/unified-import-pipeline-plan.md`. 'processing' covers both
 * the message-insertion phase and the shared-pipeline extraction drain that
 * follows it; `stage` (below) carries the human-readable detail.
 */
export type ImportJobStatus =
  | 'pending'
  | 'creating_family'
  | 'creating_identities'
  | 'submitting'
  | 'processing'
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
 * Chat export source recognized by the data model. Only 'whatsapp' has a
 * parser implemented today (see `libs/import-utils` and
 * `apps/cli/src/commands/import.ts`) -- 'telegram' and 'other' are reserved
 * for formats not yet supported, so callers can name them (and fail clearly)
 * rather than mis-detecting an unrelated format as WhatsApp.
 */
export type ImportSource = 'whatsapp' | 'telegram' | 'other';

/**
 * Import job record stored in database.
 */
export interface ImportJob {
  id: string;
  createdBy: string;
  status: ImportJobStatus;
  source: ImportSource;
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
