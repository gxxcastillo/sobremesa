import type {
  ConversationEventRepository,
  ClaimRepository,
  QuestionRepository,
  ImageRepository,
} from '@sobremesa/database';
import type { ScribeContext, ImageContext } from './types.js';

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
  /** Number of recent images to include */
  maxImages?: number;
}

const DEFAULT_OPTIONS: Required<ContextBuilderOptions> = {
  recentMessageCount: 5,
  maxQuestions: 10,
  maxClaims: 10,
  maxImages: 5,
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
    imageRepo?: ImageRepository;
  },
  options?: ContextBuilderOptions
): Promise<ScribeContext> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Fetch data in parallel for efficiency
  const [recentEvents, pendingQuestions, recentClaims, recentImages] = await Promise.all([
    repos.eventRepo.findRecent(familyId, conversationId, opts.recentMessageCount),
    repos.questionRepo.findPending(familyId, opts.maxQuestions),
    repos.claimRepo.findAllActive(familyId),
    repos.imageRepo
      ? repos.imageRepo.findRecentInConversation(familyId, conversationId, opts.maxImages)
      : Promise.resolve([]),
  ]);

  // Transform recent events to context format
  const recentMessages = recentEvents
    .filter((e) => e.contentOriginal) // Only messages with content
    .map((e) => ({
      content: e.contentOriginal || '',
      senderName: e.actorDisplayName || e.actorUsername || 'Unknown',
      occurredAt: new Date(e.occurredAt),
    }));

  // Transform images to context format
  const recentImagesContext: ImageContext[] = recentImages.map((img) => ({
    id: img.id.slice(0, 8), // Short ID for prompt efficiency
    fileType: img.fileType || 'photo',
    sharedBy: img.sharedBy,
    sharedAt: new Date(img.createdAt),
    analyzed: img.analyzed,
    description: img.analyzed
      ? (img.analysis as Record<string, unknown>)?.description as string
      : undefined,
    peopleCount: img.peopleCount,
    estimatedEra: img.estimatedEra,
    visibleText: img.visibleText?.length ? img.visibleText : undefined,
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
    recentImages: recentImagesContext,
    pendingQuestions: pendingQuestionsContext,
    recentClaims: recentClaimsContext,
  };
}
