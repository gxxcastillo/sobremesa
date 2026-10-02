import {
  ConversationEventRepository,
  FamilyRepository,
  type DatabaseClient,
} from '@sobremesa/database';
import type { AIProvider } from '@sobremesa/ai-provider';
import {
  createLogger,
  logAlert,
  textMentionsName,
} from '@sobremesa/shared-utils';
import {
  familyPrimaryLanguage,
  DEFAULT_LANGUAGE,
  type ScribeDomainModel,
  type GeneratedQuestion,
  type SupportedLanguage,
} from '@sobremesa/shared-types';
import { loadPrompt } from '@sobremesa/prompts';
import type pino from 'pino';
import { RecordContextBuilder } from './record-context';
import { buildFormulationUserPrompt } from './prompt-builder';
import {
  FollowupFormulationSchema,
  FOLLOWUP_JSON_SCHEMA,
  type RawFollowupFormulation,
} from './schema';
import type { FollowupResult } from './types';

/** The source message plus this many messages right before it, for context. */
const PRECEDING_COUNT = 5;
/** `questions.priority`'s own schema default; the model has no opinion on it. */
const DEFAULT_PRIORITY = 50;
const MAX_TOKENS = 4000;

export interface FollowupAgentOptions {
  dbClient?: DatabaseClient;
  provider: AIProvider;
  model: string;
  eventRepo?: ConversationEventRepository;
  familyRepo?: FamilyRepository;
  recordContext?: RecordContextBuilder;
  logger?: pino.Logger;
}

export interface FormulateInput {
  familyId: string;
  domainModel: Pick<
    ScribeDomainModel,
    'conversationEventId' | 'detectedLanguage'
  >;
}

/**
 * First `{...}` object in text. Claude's structured-output responses are
 * clean JSON, but this stays defensive the way every other JSON-parsing call
 * site in this codebase (Scribe's `response-parser.ts`,
 * `.agents/scripts/question-wording.ts`) does.
 */
function extractJson(text: string): string {
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return jsonMatch[0];
  }
  return text;
}

function toSupportedLanguage(
  lang: string | undefined,
): SupportedLanguage | undefined {
  return lang === 'es' || lang === 'en' ? lang : undefined;
}

/**
 * Decides whether a live message deserves a story follow-up question and, if
 * so, writes it. Pure decision + generation: it never persists a question or
 * writes to the event log -- the pipeline hook that calls it owns that (see
 * story-followups-plan.md #4).
 */
export class FollowupAgent {
  private provider: AIProvider;
  private model: string;
  private eventRepo!: ConversationEventRepository;
  private familyRepo!: FamilyRepository;
  private recordContext!: RecordContextBuilder;
  private logger: pino.Logger;

  constructor(options: FollowupAgentOptions) {
    const { dbClient } = options;

    if (options.eventRepo) {
      this.eventRepo = options.eventRepo;
    } else if (dbClient) {
      this.eventRepo = new ConversationEventRepository(dbClient);
    }

    if (options.familyRepo) {
      this.familyRepo = options.familyRepo;
    } else if (dbClient) {
      this.familyRepo = new FamilyRepository(dbClient);
    }

    if (options.recordContext) {
      this.recordContext = options.recordContext;
    } else if (dbClient) {
      this.recordContext = new RecordContextBuilder({ dbClient });
    }

    if (!this.eventRepo || !this.familyRepo || !this.recordContext) {
      throw new Error(
        'FollowupAgent requires either dbClient or all repository/builder instances',
      );
    }

    this.provider = options.provider;
    this.model = options.model;
    this.logger = options.logger || createLogger({ name: 'followup' });
  }

  async formulate(input: FormulateInput): Promise<FollowupResult> {
    const { familyId, domainModel } = input;
    const eventId = domainModel.conversationEventId;

    const message = await this.eventRepo.findById(familyId, eventId);
    if (!message || !message.contentOriginal) {
      return {
        ask: false,
        outcome: 'no_text',
        reason: 'source message has no text',
        namesUsed: [],
      };
    }

    const [precedingDesc, { block, hints }, family] = await Promise.all([
      this.eventRepo.findRecent(
        familyId,
        message.conversationId,
        PRECEDING_COUNT,
        false,
        message.sequenceNumber,
      ),
      this.recordContext.build(familyId, eventId, message.contentOriginal),
      this.familyRepo.findById(familyId),
    ]);
    // findRecent orders newest-first; the prompt wants oldest-first context.
    const preceding = [...precedingDesc].reverse();

    const language =
      toSupportedLanguage(domainModel.detectedLanguage) ??
      familyPrimaryLanguage(family?.config) ??
      DEFAULT_LANGUAGE;

    const userPrompt = buildFormulationUserPrompt({
      message,
      preceding,
      recordBlock: block,
      hints,
      language,
    });

    let responseContent: string;
    try {
      const response = await this.provider.complete({
        model: this.model,
        maxTokens: MAX_TOKENS,
        // Sonnet 5 rejects `temperature` outright (400) -- never set it here.
        system: loadPrompt('followup'),
        enablePromptCache: true,
        messages: [{ role: 'user', content: userPrompt }],
        responseFormat: {
          type: 'json_schema',
          json_schema: FOLLOWUP_JSON_SCHEMA,
        },
      });
      responseContent = response.content;
    } catch (error) {
      logAlert(
        this.logger,
        'followup_provider_error',
        { eventId, familyId, error },
        'Followup formulation call failed',
      );
      return {
        ask: false,
        outcome: 'provider_error',
        reason: 'formulation call failed',
        namesUsed: [],
      };
    }

    let parsed: RawFollowupFormulation;
    try {
      parsed = FollowupFormulationSchema.parse(
        JSON.parse(extractJson(responseContent)),
      );
    } catch (error) {
      logAlert(
        this.logger,
        'followup_unparseable_response',
        {
          eventId,
          familyId,
          error,
          responseContent: responseContent.slice(0, 500),
        },
        'Followup formulation response failed schema validation',
      );
      return {
        ask: false,
        outcome: 'unparseable_response',
        reason: 'unparseable response',
        namesUsed: [],
      };
    }

    if (!parsed.ask) {
      return {
        ask: false,
        outcome: 'declined',
        reason: parsed.reason,
        namesUsed: [],
      };
    }

    if (!parsed.question.trim()) {
      this.logger.warn(
        { eventId, familyId },
        'Followup formulation said ask=true with empty question text; treating as a decline',
      );
      return {
        ask: false,
        outcome: 'empty_question',
        reason: 'ask=true with empty question text',
        namesUsed: [],
      };
    }

    // Deterministic guard (story-followups-plan.md #3): every named person,
    // place or event must appear in what the model was actually shown. Whole
    // -word matching (not raw substring containment) so a hallucinated name
    // that merely happens to be a substring of something shown (e.g. "Ana"
    // inside "Mariana") is still caught.
    const ungroundedNames = parsed.names_used.filter(
      (name) => !textMentionsName(userPrompt, name),
    );
    if (ungroundedNames.length) {
      this.logger.warn(
        { eventId, familyId, ungroundedNames },
        'Followup formulation named something not shown to the model; treating as a decline',
      );
      return {
        ask: false,
        outcome: 'ungrounded_names',
        reason: `named entities not shown to the model: ${ungroundedNames.join(', ')}`,
        namesUsed: [],
      };
    }

    const question: GeneratedQuestion = {
      content: parsed.question,
      language,
      priority: DEFAULT_PRIORITY,
      origin: 'followup',
      storyContext: parsed.story_context || undefined,
    };

    return {
      ask: true,
      outcome: 'asked',
      question,
      reason: parsed.reason,
      namesUsed: parsed.names_used,
    };
  }
}
