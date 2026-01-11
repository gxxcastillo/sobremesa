import type {
  ConversationEventRepository,
  PersonRepository,
  PlaceRepository,
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
  /** Number of existing people to include */
  maxPeople?: number;
  /** Number of existing places to include */
  maxPlaces?: number;
  /** Number of pending questions to include */
  maxQuestions?: number;
  /** Number of recent claims to include */
  maxClaims?: number;
}

const DEFAULT_OPTIONS: Required<ContextBuilderOptions> = {
  recentMessageCount: 5,
  maxPeople: 20,
  maxPlaces: 15,
  maxQuestions: 10,
  maxClaims: 10,
};

/**
 * Build context for the Scribe agent from database repositories.
 */
export async function buildScribeContext(
  familyId: string,
  conversationId: string,
  repos: {
    eventRepo: ConversationEventRepository;
    personRepo: PersonRepository;
    placeRepo: PlaceRepository;
    claimRepo: ClaimRepository;
    questionRepo: QuestionRepository;
  },
  options?: ContextBuilderOptions
): Promise<ScribeContext> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Fetch data in parallel for efficiency
  const [recentEvents, people, places, pendingQuestions, recentClaims] =
    await Promise.all([
      repos.eventRepo.findRecent(familyId, conversationId, opts.recentMessageCount),
      repos.personRepo.findAllActive(familyId),
      repos.placeRepo.findAllActive(familyId),
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

  // Transform people to context format
  const existingPeople = people.slice(0, opts.maxPeople).map((p) => ({
    name: p.name,
    aliases: p.aliases || [],
  }));

  // Transform places to context format
  const existingPlaces = places.slice(0, opts.maxPlaces).map((p) => ({
    name: p.name,
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
    existingPeople,
    existingPlaces,
    pendingQuestions: pendingQuestionsContext,
    recentClaims: recentClaimsContext,
  };
}
