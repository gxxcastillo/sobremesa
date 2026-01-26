import type {
  ConversationEventRepository,
  ImageRepository,
} from '@sobremesa/database';
import type { MessageContext } from '@sobremesa/queue';
import type { ScribeContext, ImageContext } from './types';

/**
 * Options for building Scribe context.
 */
export interface ContextBuilderOptions {
  /** Number of recent messages to include */
  recentMessageCount?: number;
  /** Number of recent images to include */
  maxImages?: number;
}

const DEFAULT_OPTIONS: Required<ContextBuilderOptions> = {
  recentMessageCount: 5,
  maxImages: 5,
};

/**
 * Convert MessageContext from the processor to ScribeContext.
 */
export function convertToScribeContext(context: MessageContext): ScribeContext {
  return {
    recentMessages: context.recentMessages.map((m) => ({
      content: m.content,
      senderName: m.senderName,
      occurredAt: m.occurredAt,
    })),
    recentImages: context.recentImages.map((img) => ({
      id: img.id.slice(0, 8), // Short ID for prompt efficiency
      fileType: img.fileType,
      sharedBy: img.sharedBy,
      sharedAt: img.sharedAt,
      analyzed: img.analyzed,
      description: img.description,
      peopleCount: img.peopleCount,
      estimatedEra: img.estimatedEra,
      visibleText: img.visibleText,
    })),
  };
}

/**
 * Build context for the Scribe agent from database repositories.
 * Note: People and places are no longer included - Registrar handles entity matching.
 * If preloadedContext is provided, it will be converted to ScribeContext instead of fetching from DB.
 */
export async function buildScribeContext(
  familyId: string,
  conversationId: string,
  repos: {
    eventRepo: ConversationEventRepository;
    imageRepo?: ImageRepository;
  },
  options?: ContextBuilderOptions,
  preloadedContext?: MessageContext,
): Promise<ScribeContext> {
  // Use preloaded context if available
  if (preloadedContext) {
    return convertToScribeContext(preloadedContext);
  }

  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Fetch data in parallel for efficiency
  const [recentEvents, recentImages] = await Promise.all([
    repos.eventRepo.findRecent(
      familyId,
      conversationId,
      opts.recentMessageCount,
    ),
    repos.imageRepo
      ? repos.imageRepo.findRecentInConversation(
          familyId,
          conversationId,
          opts.maxImages,
        )
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
      ? ((img.analysis as Record<string, unknown>)?.description as string)
      : undefined,
    peopleCount: img.peopleCount,
    estimatedEra: img.estimatedEra,
    visibleText: img.visibleText?.length ? img.visibleText : undefined,
  }));

  return {
    recentMessages,
    recentImages: recentImagesContext,
  };
}
