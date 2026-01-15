import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '@sobremesa/shared-utils';
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

    // Configure Admin agent (doesn't require Anthropic API)
    logger.debug('Configuring Admin agent...');
    const admin = new AdminAgent({
      messageSender: botManager,
    });
    processor.setAdminProcessor((eventId, familyId, subtype) =>
      admin.handle(eventId, familyId, subtype),
    );
    logger.info('Admin agent configured');

    // Create Anthropic client if API key is available
    const anthropic = anthropicApiKey
      ? new Anthropic({ apiKey: anthropicApiKey })
      : undefined;

    // Configure Facilitator agent (with optional AI for warmth transformation)
    logger.debug('Configuring Facilitator agent...');
    const facilitator = new FacilitatorAgent({
      messageSender: botManager,
      anthropic, // Pass anthropic client for warmth formula
      minMinutesBetweenQuestions: 5,
    });
    logger.info({ hasAI: !!anthropic }, 'Facilitator agent configured');

    // Configure AI agents if API key is available
    if (anthropic) {
      logger.debug(
        'Configuring Intern, Scribe, Registrar and Historian agents...',
      );

      const intern = new InternAgent({
        anthropic,
        config: { botUsername: botInfo.username },
      });
      const scribe = new ScribeAgent({ anthropic });
      const registrar = new RegistrarAgent();
      const historian = new HistorianAgent({ anthropic });

      // Set router (Intern routes to admin/scribe/ignore)
      processor.setRouter((eventId, familyId) =>
        intern.route(eventId, familyId),
      );
      processor.setImageLinker((eventId, familyId) =>
        intern.linkToImage(eventId, familyId),
      );
      processor.setScribe((eventId, familyId) =>
        scribe.process(eventId, familyId),
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

    // Start the bot
    await botManager.start();
    logger.info('Bot is running. Press Ctrl+C to stop.');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ err: err.message, stack: err.stack }, 'Failed to start');
    console.error('Startup error:', err);
    process.exit(1);
  }
}

main();
