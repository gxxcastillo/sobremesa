import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '@sobremesa/shared-utils';
import {
  loadAIConfig,
  createAIProviderFactory,
  validateConfig,
} from '@sobremesa/ai-provider';
import { MessageQueue, MessageProcessor } from '@sobremesa/queue';
import { BotManager } from '@sobremesa/telegram';
import { AdminAgent } from '@sobremesa/agents-admin';
import { HistorianAgent } from '@sobremesa/agents-historian';
import { InternAgent } from '@sobremesa/agents-intern';
import { ScribeAgent } from '@sobremesa/agents-scribe';
import { RegistrarAgent } from '@sobremesa/agents-registrar';
import { FacilitatorAgent } from '@sobremesa/agents-facilitator';

const logger = createLogger({ name: 'chatbots' });

function validateEnv(): { token: string; anthropicApiKey?: string } {
  const missing: string[] = [];

  const token = process.env['TELEGRAM_BOT_TOKEN'];
  if (!token) missing.push('TELEGRAM_BOT_TOKEN');

  if (!process.env['SUPABASE_URL']) missing.push('SUPABASE_URL');
  if (!process.env['SUPABASE_ANON_KEY']) missing.push('SUPABASE_ANON_KEY');
  if (!process.env['SUPABASE_SERVICE_ROLE_KEY'])
    missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!process.env['ACCESS_PASS_SECRET']) missing.push('ACCESS_PASS_SECRET');

  if (missing.length > 0) {
    logger.error({ missing }, 'Missing required environment variables');
    process.exit(1);
  }

  const anthropicApiKey = process.env['ANTHROPIC_API_KEY'];
  if (!anthropicApiKey) {
    logger.warn('ANTHROPIC_API_KEY not set - agents will not process messages');
  }

  return { token: token as string, anthropicApiKey };
}

async function main() {
  logger.info('Starting Sobremesa conversation gateway...');

  const { token, anthropicApiKey } = validateEnv();

  try {
    logger.debug('Creating BotManager...');
    const botManager = new BotManager({ token, logger });

    // Get bot info for mention detection
    logger.debug('Fetching bot info...');
    const botInfo = await botManager.getBot().telegram.getMe();
    logger.info({ username: botInfo.username }, 'Bot info retrieved');

    logger.debug('Creating MessageProcessor...');
    const processor = new MessageProcessor();

    // Configure Admin agent (doesn't require AI)
    logger.debug('Configuring Admin agent...');
    const admin = new AdminAgent({
      messageSender: botManager,
    });
    processor.setAdminProcessor((eventId, familyId, subtype) =>
      admin.handle(eventId, familyId, subtype),
    );
    logger.info('Admin agent configured');

    // Load AI configuration from environment
    const aiConfig = loadAIConfig(
      process.env as Record<string, string | undefined>,
    );
    const configWarnings = validateConfig(aiConfig);
    if (configWarnings.length > 0) {
      for (const warning of configWarnings) {
        logger.warn(warning);
      }
    }
    logger.info(
      {
        providers: Object.keys(aiConfig.providers),
        default: aiConfig.defaultProvider,
      },
      'AI configuration loaded',
    );

    // Create Anthropic client if API key is available
    const anthropic = anthropicApiKey
      ? new Anthropic({ apiKey: anthropicApiKey })
      : undefined;

    // Create AI provider factory
    const aiFactory = createAIProviderFactory(aiConfig, anthropic);
    const hasAIProvider = aiConfig.defaultProvider !== 'mock';

    // Configure Facilitator agent (with optional AI for warmth transformation)
    logger.debug('Configuring Facilitator agent...');
    const facilitatorProvider = hasAIProvider
      ? aiFactory.getProviderForAgent('facilitator')
      : undefined;
    const facilitator = new FacilitatorAgent({
      messageSender: botManager,
      provider: facilitatorProvider,
      model: aiFactory.getModelForAgent('facilitator'),
      minMinutesBetweenQuestions: 5,
    });
    logger.info({ hasAI: hasAIProvider }, 'Facilitator agent configured');

    // Configure AI agents if a provider is available
    if (hasAIProvider) {
      logger.debug(
        'Configuring Intern, Scribe, Registrar and Historian agents...',
      );

      const intern = new InternAgent({
        provider: aiFactory.getProviderForAgent('intern'),
        model: aiFactory.getModelForAgent('intern'),
        config: { botUsername: botInfo.username },
      });
      const scribe = new ScribeAgent({
        provider: aiFactory.getProviderForAgent('scribe'),
        model: aiFactory.getModelForAgent('scribe'),
      });
      const registrar = new RegistrarAgent();
      const historian = new HistorianAgent({
        provider: aiFactory.getProviderForAgent('historian'),
        model: aiFactory.getModelForAgent('historian'),
      });

      // Set router (Intern routes to admin/scribe/ignore)
      // Context is pre-fetched by MessageProcessor and shared to avoid duplicate DB queries
      processor.setRouter((eventId, familyId, context) =>
        intern.route(eventId, familyId, context),
      );
      processor.setFilter((eventId, familyId, context) =>
        intern.filter(eventId, familyId, context),
      );
      processor.setImageLinker((eventId, familyId, context) =>
        intern.linkToImage(eventId, familyId, context),
      );
      processor.setScribe((eventId, familyId, context) =>
        scribe.process(eventId, familyId, context),
      );
      processor.setHistorianProcessor(async (eventId, familyId) => {
        // 1. Historian generates the answer
        const result = await historian.answer(eventId, familyId);
        if (!result.success || !result.answer) {
          return { success: result.success, error: result.error ?? '' };
        }

        // 2. Facilitator formats and sends the response with appropriate warmth/language
        const responseResult = await facilitator.sendResponse({
          familyId,
          originalQuestion: result.originalQuestion,
          historianAnswer: result.answer,
          chatId: result.chatId,
          replyToMessageId: result.replyToMessageId,
        });

        return { success: responseResult.success, error: responseResult.error };
      });
      processor.setRegistrar(async (model, familyId) => {
        await registrar.persist(model, familyId);

        // Fire-and-forget: trigger Facilitator after persist
        // Log errors but don't block or retry
        facilitator.askNextQuestion(familyId).then(
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
      });

      logger.info('Intern, Scribe, Registrar and Historian agents configured');
    }

    logger.debug('Starting MessageQueue...');
    const queue = new MessageQueue();
    queue.setHandler(processor.createHandler());
    await queue.start();
    logger.info('Message queue started');

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Received shutdown signal');
      await queue.stop();
      await botManager.stop(signal);
      process.exit(0);
    };

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGHUP', () => shutdown('SIGHUP'));

    // Start the bot
    await botManager.start();
    logger.info('Bot is running. Press Ctrl+C to stop.');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));

    // Check for Telegram 409 conflict (another bot instance is polling)
    if (err.message.includes('409') && err.message.includes('Conflict')) {
      logger.error(
        'Another bot instance is already running and polling Telegram.',
      );
      console.error('\n❌ Bot Conflict Error\n');
      console.error(
        'Another instance of this bot is already polling Telegram.',
      );
      console.error('Only one instance can use long-polling at a time.\n');
      console.error('Possible causes:');
      console.error('  1. A deployed instance (cloud/production) is running');
      console.error('  2. Another local process is still running');
      console.error('  3. A zombie process from a previous session\n');
      console.error('To find local processes:');
      console.error(
        '  ps aux | grep -E "(chatbots|telegraf)" | grep -v grep\n',
      );
      process.exit(1);
    }

    logger.error({ err: err.message, stack: err.stack }, 'Failed to start');
    console.error('Startup error:', err);
    process.exit(1);
  }
}

main();
