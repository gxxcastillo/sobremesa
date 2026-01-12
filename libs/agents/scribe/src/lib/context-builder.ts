import type {
  ConversationEventRepository,
  ClaimRepository,
  QuestionRepository,
} from '@sobremesa/database';
import type { ScribeContext } from './types.js';

/**
 * Options for building Scribe context.
 */
export interface ContextBuilderOptions {
  /** Number of recent messages to include */
  recentMessageCount?: number;
  /** Number of pending questions to include */
  maxQuestions?: number;
  /** Number of recent claims to include */
  maxClaims?: number;
}

const DEFAULT_OPTIONS: Required<ContextBuilderOptions> = {
  recentMessageCount: 5,
  maxQuestions: 10,
  maxClaims: 10,
};

/**
 * Build context for the Scribe agent from database repositories.
 * Note: People and places are no longer included - Registrar handles entity matching.
 */
export async function buildScribeContext(
  familyId: string,
  conversationId: string,
  repos: {
    eventRepo: ConversationEventRepository;
    claimRepo: ClaimRepository;
    questionRepo: QuestionRepository;
  },
  options?: ContextBuilderOptions
): Promise<ScribeContext> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Fetch data in parallel for efficiency
  const [recentEvents, pendingQuestions, recentClaims] = await Promise.all([
    repos.eventRepo.findRecent(familyId, conversationId, opts.recentMessageCount),
    repos.questionRepo.findPending(familyId, opts.maxQuestions),
    repos.claimRepo.findAllActive(familyId),
  ]);

  // Transform recent events to context format
  const recentMessages = recentEvents
    .filter((e) => e.contentOriginal) // Only messages with content
    .map((e) => ({
      content: e.contentOriginal || '',
      senderName: e.actorDisplayName || e.actorUsername || 'Unknown',
      occurredAt: new Date(e.occurredAt),
    }));

  // Transform questions to context format
  const pendingQuestionsContext = pendingQuestions.map((q) => ({
    id: q.id,
    content: q.contentOriginal,
  }));

  // Transform claims to context format
  const recentClaimsContext = recentClaims.slice(0, opts.maxClaims).map((c) => ({
    subject: c.subject,
    claimValue: c.claimValue,
    claimedBy: c.claimedBy,
  }));

  return {
    recentMessages,
    pendingQuestions: pendingQuestionsContext,
    recentClaims: recentClaimsContext,
  };
}
