import type pino from 'pino';
import type { AIProvider } from '@sobremesa/ai-provider';
import { QuestionRepository, EventLogRepository } from '@sobremesa/database';
import type { DatabaseClient } from '@sobremesa/database';
import type { MessageSender } from '@sobremesa/shared-types';
import { createLogger } from '@sobremesa/shared-utils';
import { MessageProcessor } from '@sobremesa/queue';
import { AdminAgent } from '@sobremesa/agents-admin';
import { InternAgent, INTERN_VERSION } from '@sobremesa/agents-intern';
import { ScribeAgent, SCRIBE_VERSION } from '@sobremesa/agents-scribe';
import { RegistrarAgent } from '@sobremesa/agents-registrar';
import { HistorianAgent } from '@sobremesa/agents-historian';
import { FacilitatorAgent } from '@sobremesa/agents-facilitator';
import { FollowupAgent } from '@sobremesa/agents-followup';
import { createStoryFollowupHook } from './story-followup-hook';

/**
 * Named stages of the live message pipeline. Each maps to one or more
 * `MessageProcessor` setter registrations; callers select exactly the
 * stages they need instead of the pipeline being all-or-nothing.
 *
 * `facilitatorNudge` is deliberately its own stage, separate from
 * `historian`: `historian` bundles Historian's answer with Facilitator's
 * response *formatting* (replying to a question that was asked), while
 * `facilitatorNudge` is Facilitator proactively *asking* a new question
 * after a Registrar persist. A caller that omits `facilitatorNudge` (e.g.
 * an import pipeline) is guaranteed no outbound question send.
 *
 * `storyFollowup` (story-followups-plan.md #4) is a third, independent
 * stage: it only proposes a follow-up question (writes `questions`/event
 * log), never sends one -- `facilitatorNudge`/#6's periodic check own
 * asking. A caller that omits it is guaranteed no follow-up is ever
 * proposed.
 */
export type PipelineStage =
  | 'admin'
  | 'router'
  | 'filter'
  | 'imageLinker'
  | 'scribe'
  | 'registrar'
  | 'historian'
  | 'facilitatorNudge'
  | 'storyFollowup';

export type PipelineAgentProviders = Partial<
  Record<
    'intern' | 'scribe' | 'historian' | 'facilitator' | 'followup',
    AIProvider
  >
>;

export type PipelineAgentModels = Partial<
  Record<'intern' | 'scribe' | 'historian' | 'facilitator' | 'followup', string>
>;

export interface BuildPipelineOptions {
  dbClient: DatabaseClient;
  stages: Set<PipelineStage>;
  providers: PipelineAgentProviders;
  models: PipelineAgentModels;
  /** Required if 'admin' | 'historian' | 'facilitatorNudge' is requested. */
  messageSender?: MessageSender;
  /** Optional -- Intern @-mention detection only. */
  botUsername?: string;
  logger?: pino.Logger;
  /** Facilitator ask-rate throttle; only relevant with 'facilitatorNudge'. */
  minMinutesBetweenQuestions?: number;
}

/**
 * Builds and wires a `MessageProcessor` for exactly the requested pipeline
 * stages. Internals mirror `apps/chatbots/src/main.ts`'s construction
 * exactly. When both `router` and `filter` are requested, `MessageProcessor`
 * skips the registered `filter` stage's own call (the router already calls
 * `intern.filter()` internally) and writes the canonical `intern_evaluated`
 * audit event directly from the router branch, so it fires exactly once per
 * event regardless of which stage combination is requested.
 *
 * Validates eagerly: a stage that needs a provider/model/message sender
 * that wasn't supplied throws immediately, rather than constructing a
 * processor that would only fail the first time that stage actually runs.
 */
export function buildMessagePipeline(
  options: BuildPipelineOptions,
): MessageProcessor {
  const { dbClient, stages, providers, models } = options;
  const logger = options.logger ?? createLogger({ name: 'pipeline' });
  const wants = (stage: PipelineStage) => stages.has(stage);

  // --- Validate up front. ---
  const messageSenderStages = (
    ['admin', 'historian', 'facilitatorNudge'] as const
  ).filter(wants);
  if (messageSenderStages.length > 0 && !options.messageSender) {
    throw new Error(
      `buildMessagePipeline: stage(s) [${messageSenderStages.join(', ')}] require options.messageSender`,
    );
  }

  const internStages = (['router', 'filter', 'imageLinker'] as const).filter(
    wants,
  );
  const needsIntern = internStages.length > 0;
  if (needsIntern && (!providers.intern || !models.intern)) {
    throw new Error(
      `buildMessagePipeline: stage(s) [${internStages.join(', ')}] require providers.intern and models.intern`,
    );
  }

  if (wants('scribe') && (!providers.scribe || !models.scribe)) {
    throw new Error(
      "buildMessagePipeline: 'scribe' stage requires providers.scribe and models.scribe",
    );
  }

  if (wants('historian') && (!providers.historian || !models.historian)) {
    throw new Error(
      "buildMessagePipeline: 'historian' stage requires providers.historian and models.historian",
    );
  }

  if (wants('storyFollowup') && (!providers.followup || !models.followup)) {
    throw new Error(
      "buildMessagePipeline: 'storyFollowup' stage requires providers.followup and models.followup",
    );
  }

  // Both 'historian' (Historian returns, Facilitator sends -- see
  // docs/decisions/024-historian-returns-facilitator-sends.md) and
  // 'facilitatorNudge' construct a FacilitatorAgent below and need its
  // provider/model. FacilitatorAgent no longer defaults `model` when
  // omitted (the old DEFAULT_WARMTH_MODEL fallback was removed) --
  // without this check, a provider-only (or model-only) caller would
  // construct successfully here and only fail later, at the first
  // warmth-formatting call, with a misleading "No AI provider available"
  // error even when the provider was actually set.
  const facilitatorStages = (['historian', 'facilitatorNudge'] as const).filter(
    wants,
  );
  if (
    facilitatorStages.length > 0 &&
    (!providers.facilitator || !models.facilitator)
  ) {
    throw new Error(
      `buildMessagePipeline: stage(s) [${facilitatorStages.join(', ')}] require providers.facilitator and models.facilitator`,
    );
  }

  if (wants('facilitatorNudge')) {
    if (!wants('registrar')) {
      // The nudge only has a place to run from: MessageProcessor fires it
      // from inside the registrar setter, right after a persist (mirroring
      // main.ts). Without 'registrar' it would silently never fire.
      throw new Error(
        "buildMessagePipeline: 'facilitatorNudge' stage requires the 'registrar' stage (the nudge fires after a Registrar persist)",
      );
    }
  }

  if (wants('storyFollowup') && !wants('registrar')) {
    // MessageProcessor requires the hook slot to exist regardless, but the
    // stage combination is nonsensical without 'registrar': the whole point
    // is to run right after a Registrar persist (or in place of the early
    // return on the ignore route).
    throw new Error(
      "buildMessagePipeline: 'storyFollowup' stage requires the 'registrar' stage",
    );
  }

  const messageSender = options.messageSender as MessageSender;

  // --- Construct agents and wire the processor. ---
  const processor = new MessageProcessor({ dbClient, logger });

  if (wants('admin')) {
    const admin = new AdminAgent({ dbClient, messageSender, logger });
    processor.setAdminProcessor((eventId, familyId, subtype) =>
      admin.handle(eventId, familyId, subtype),
    );
  }

  let intern: InternAgent | undefined;
  if (needsIntern) {
    intern = new InternAgent({
      dbClient,
      provider: providers.intern as AIProvider,
      model: models.intern as string,
      logger,
      config: { botUsername: options.botUsername },
    });
  }
  if (wants('router')) {
    // Context is pre-fetched by MessageProcessor and shared to avoid
    // duplicate DB queries.
    processor.setRouter((eventId, familyId, context) =>
      (intern as InternAgent).route(eventId, familyId, context),
    );
  }
  if (wants('filter')) {
    processor.setFilter((eventId, familyId, context) =>
      (intern as InternAgent).filter(eventId, familyId, context),
    );
  }
  if (wants('imageLinker')) {
    processor.setImageLinker((eventId, familyId, context) =>
      (intern as InternAgent).linkToImage(eventId, familyId, context),
    );
  }

  let scribe: ScribeAgent | undefined;
  if (wants('scribe')) {
    scribe = new ScribeAgent({
      dbClient,
      provider: providers.scribe as AIProvider,
      model: models.scribe as string,
      logger,
    });
    processor.setScribe((eventId, familyId, context, preprocessed) =>
      (scribe as ScribeAgent).process(eventId, familyId, context, preprocessed),
    );
  }

  if (needsIntern || wants('scribe')) {
    processor.setPipelineVersions({
      internVersion: needsIntern ? INTERN_VERSION : undefined,
      scribeVersion: wants('scribe') ? SCRIBE_VERSION : undefined,
    });
  }

  let registrar: RegistrarAgent | undefined;
  if (wants('registrar')) {
    registrar = new RegistrarAgent({ dbClient, logger });
  }

  let facilitator: FacilitatorAgent | undefined;
  if (wants('historian') || wants('facilitatorNudge')) {
    facilitator = new FacilitatorAgent({
      dbClient,
      messageSender,
      provider: providers.facilitator,
      model: models.facilitator,
      logger,
      minMinutesBetweenQuestions: options.minMinutesBetweenQuestions,
    });
  }

  if (wants('historian')) {
    const historian = new HistorianAgent({
      dbClient,
      provider: providers.historian as AIProvider,
      model: models.historian as string,
      logger,
    });
    processor.setHistorianProcessor(async (eventId, familyId) => {
      // 1. Historian generates the answer.
      const result = await historian.answer(eventId, familyId);
      if (!result.success || !result.answer) {
        return { success: result.success, error: result.error ?? '' };
      }

      // 2. Facilitator formats and sends the response with appropriate
      // warmth/language.
      const responseResult = await (
        facilitator as FacilitatorAgent
      ).sendResponse({
        familyId,
        originalQuestion: result.originalQuestion,
        historianAnswer: result.answer,
        chatId: result.chatId,
        replyToMessageId: result.replyToMessageId,
      });

      return { success: responseResult.success, error: responseResult.error };
    });
  }

  if (wants('registrar')) {
    processor.setRegistrar(
      async (domainModel, familyId, pipelineVersions, contextContents) => {
        await (registrar as RegistrarAgent).persist(
          domainModel,
          familyId,
          pipelineVersions,
          contextContents,
        );

        if (wants('facilitatorNudge')) {
          // Fire-and-forget: trigger Facilitator after persist. Log errors
          // but don't block or retry.
          (facilitator as FacilitatorAgent).askNextQuestion(familyId).then(
            (result) => {
              if (result.questionContent) {
                logger.info(
                  { familyId, questionId: result.questionId },
                  'Facilitator asked question',
                );
              } else if (result.skippedReason) {
                logger.debug(
                  { familyId, reason: result.skippedReason },
                  'Facilitator skipped asking',
                );
              }
            },
            (err) => {
              logger.error(
                { familyId, err },
                'Facilitator failed to ask question',
              );
            },
          );
        }
      },
    );
  }

  if (wants('storyFollowup')) {
    const followup = new FollowupAgent({
      dbClient,
      provider: providers.followup as AIProvider,
      model: models.followup as string,
      logger,
    });
    processor.setStoryFollowupHook(
      createStoryFollowupHook({
        followup,
        questionRepo: new QuestionRepository(dbClient),
        eventLog: new EventLogRepository(dbClient),
        logger,
      }),
    );
  }

  return processor;
}
