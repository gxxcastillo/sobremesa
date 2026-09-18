import type pino from 'pino';
import type {
  QuestionRepository,
  EventLogRepository,
} from '@sobremesa/database';
import type { FollowupAgent } from '@sobremesa/agents-followup';
import type { StoryFollowupHook } from '@sobremesa/queue';

/** No new question is written while one is waiting or one was asked this
 * recently -- Gabriel's "one question per moment; a day later is a new
 * moment" (story-followups-plan.md D2/#4/#5). */
const PACING_HOURS = 24;
/** A proposed follow-up question expires unasked after this long (D3). */
const EXPIRY_HOURS = 24;

export interface StoryFollowupHookOptions {
  followup: FollowupAgent;
  questionRepo: QuestionRepository;
  eventLog: EventLogRepository;
  logger: pino.Logger;
}

/**
 * Builds the story follow-up pipeline hook (story-followups-plan.md #4):
 * the pacing pre-check, then `FollowupAgent`'s decision, then the
 * persistence and `question_proposed` event-log entry that `FollowupAgent`
 * deliberately never writes itself. No nudge -- the question can't be asked
 * until the chat has been quiet (D2), so a later periodic check (#6) is what
 * actually sends it.
 */
export function createStoryFollowupHook(
  options: StoryFollowupHookOptions,
): StoryFollowupHook {
  const { followup, questionRepo, eventLog, logger } = options;

  return async (eventId, familyId, routedLanguage) => {
    if (await questionRepo.hasWaitingOrRecent(familyId, PACING_HOURS)) {
      logger.debug(
        { eventId, familyId },
        'Story follow-up skipped: pacing (a question is waiting or was asked recently)',
      );
      return;
    }

    const result = await followup.formulate({
      familyId,
      domainModel: {
        conversationEventId: eventId,
        detectedLanguage: routedLanguage,
      },
    });

    if (!result.ask || !result.question) {
      logger.debug(
        { eventId, familyId, reason: result.reason },
        'Story follow-up declined',
      );
      return;
    }

    const expiresAt = new Date(Date.now() + EXPIRY_HOURS * 60 * 60 * 1000);
    const question = await questionRepo.createFromGenerated(
      familyId,
      result.question,
      eventId,
      expiresAt,
    );

    await eventLog.log({
      familyId,
      eventType: 'question_proposed',
      eventCategory: 'system_event',
      actor: 'followup',
      actorType: 'system',
      conversationEventId: eventId,
      eventData: { questionId: question.id, namesUsed: result.namesUsed },
    });

    logger.info(
      { eventId, familyId, questionId: question.id },
      'Story follow-up question proposed',
    );
  };
}
