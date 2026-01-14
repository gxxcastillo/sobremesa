import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '@sobremesa/shared-utils';
import { MessageQueue, MessageProcessor } from '@sobremesa/queue';
import { BotManager } from '@sobremesa/telegram';
import { AdminAgent } from '@sobremesa/agents-admin';
import { InternAgent } from '@sobremesa/agents-intern';
import { ScribeAgent } from '@sobremesa/agents-scribe';
import { RegistrarAgent } from '@sobremesa/agents-registrar';
import { FacilitatorAgent } from '@sobremesa/agents-facilitator';

const logger = createLogger({ name: 'chatbots' });

async function main() {
  logger.info('Starting Sobremesa conversation gateway...');

  // Get bot token from environment
  const token =
    process.env['TELEGRAM_BOT_TOKEN'] ||
    process.env['TELEGRAM_BOT_TOKEN_SCRIBE']; // Fallback for migration

  if (!token) {
    logger.error('TELEGRAM_BOT_TOKEN is required');
    process.exit(1);
  }

  const anthropicApiKey = process.env['ANTHROPIC_API_KEY'];
  if (!anthropicApiKey) {
    logger.warn('ANTHROPIC_API_KEY not set - agents will not process messages');
  }

  try {
    logger.debug('Creating BotManager...');
    const botManager = new BotManager({ token, logger });

    logger.debug('Creating MessageProcessor...');
    const processor = new MessageProcessor();

    // Configure Admin agent (doesn't require Anthropic API)
    logger.debug('Configuring Admin agent...');
    const admin = new AdminAgent({
      messageSender: botManager,
    });
    processor.setAdminProcessor((eventId, familyId, subtype) =>
      admin.handle(eventId, familyId, subtype)
    );
    logger.info('Admin agent configured');

    // Configure Facilitator agent
    logger.debug('Configuring Facilitator agent...');
    const facilitator = new FacilitatorAgent({
      messageSender: botManager,
      minMinutesBetweenQuestions: 5,
    });
    logger.info('Facilitator agent configured');

    // Configure AI agents if API key is available
    if (anthropicApiKey) {
      logger.debug('Configuring Intern, Scribe and Registrar agents...');
      const anthropic = new Anthropic({ apiKey: anthropicApiKey });

      const intern = new InternAgent({ anthropic });
      const scribe = new ScribeAgent({ anthropic });
      const registrar = new RegistrarAgent();

      // Set router (Intern routes to admin/scribe/ignore)
      processor.setRouter((eventId, familyId) =>
        intern.route(eventId, familyId)
      );
      processor.setImageLinker((eventId, familyId) =>
        intern.linkToImage(eventId, familyId)
      );
      processor.setScribe((eventId, familyId) =>
        scribe.process(eventId, familyId)
      );
      processor.setRegistrar(async (model, familyId) => {
        await registrar.persist(model, familyId);

        // Fire-and-forget: trigger Facilitator after persist
        // Log errors but don't block or retry
        facilitator.askNextQuestion(familyId).then(
          (result) => {
            if (result.questionContent) {
              logger.info(
                { familyId, questionId: result.questionId },
                'Facilitator asked question'
              );
            } else if (result.skippedReason) {
              logger.debug(
                { familyId, reason: result.skippedReason },
                'Facilitator skipped asking'
              );
            }
          },
          (err) => {
            logger.error(
              { familyId, err },
              'Facilitator failed to ask question'
            );
          }
        );
      });

      logger.info('Intern, Scribe and Registrar agents configured');
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
