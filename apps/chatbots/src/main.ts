import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '@sobremesa/shared-utils';
import { MessageQueue, MessageProcessor } from '@sobremesa/queue';
import { BotManager } from '@sobremesa/telegram';
import { InternAgent } from '@sobremesa/agents-intern';
import { ScribeAgent } from '@sobremesa/agents-scribe';
import { RegistrarAgent } from '@sobremesa/agents-registrar';
import { FacilitatorAgent } from '@sobremesa/agents-facilitator';

const logger = createLogger({ name: 'chatbots' });

async function main() {
  logger.info('Starting Sobremesa conversation gateway...');

  // Get bot tokens from environment
  const scribeToken = process.env['TELEGRAM_BOT_TOKEN_SCRIBE'];
  const adminToken = process.env['TELEGRAM_BOT_TOKEN_ADMIN'];
  const facilitatorToken = process.env['TELEGRAM_BOT_TOKEN_FACILITATOR'];

  if (!scribeToken) {
    logger.error('At least TELEGRAM_BOT_TOKEN_SCRIBE is required');
    process.exit(1);
  }

  const anthropicApiKey = process.env['ANTHROPIC_API_KEY'];
  if (!anthropicApiKey) {
    logger.warn('ANTHROPIC_API_KEY not set - Scribe agent will not process messages');
  }

  try {
    logger.debug('Creating BotManager...');
    // Create bot manager with available tokens
    // Note: Family ID is looked up dynamically by chat ID via /register command
    const botManager = new BotManager({
      scribeToken,
      adminToken,
      facilitatorToken,
      logger,
    });

    // Log which bots are configured
    const roles = botManager.getConfiguredRoles();
    logger.info({ roles }, 'Bots configured');

    logger.debug('Creating MessageProcessor...');
    // Set up message processing pipeline
    const processor = new MessageProcessor();

    // Configure Facilitator agent if bot is available
    let facilitator: FacilitatorAgent | undefined;
    if (botManager.hasBot('facilitator')) {
      logger.debug('Configuring Facilitator agent...');
      facilitator = new FacilitatorAgent({
        messageSender: botManager,
        minMinutesBetweenQuestions: 5, // Ask at most once every 5 minutes per family
      });
      logger.info('Facilitator agent configured');
    }

    // Configure agents if API key is available
    if (anthropicApiKey) {
      logger.debug('Configuring Intern, Scribe and Registrar agents...');
      const anthropic = new Anthropic({ apiKey: anthropicApiKey });

      // Intern uses Haiku for quick preprocessing tasks
      const intern = new InternAgent({ anthropic });
      const scribe = new ScribeAgent({ anthropic });
      const registrar = new RegistrarAgent();

      processor.setFilter((eventId, familyId) => intern.filter(eventId, familyId));
      processor.setImageLinker((eventId, familyId) => intern.linkToImage(eventId, familyId));
      processor.setScribe((eventId, familyId) => scribe.process(eventId, familyId));
      processor.setRegistrar(async (model, familyId) => {
        await registrar.persist(model, familyId);

        // After persisting, try to ask a follow-up question
        // Rate limiting in FacilitatorAgent prevents spam
        if (facilitator) {
          // Small delay to let the conversation settle
          setTimeout(async () => {
            try {
              const result = await facilitator!.askNextQuestion(familyId);
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
            } catch (err) {
              logger.error({ familyId, err }, 'Facilitator failed to ask question');
            }
          }, 3000); // Wait 3 seconds before asking
        }
      });

      logger.info('Intern, Scribe and Registrar agents configured');
    }

    logger.debug('Starting MessageQueue...');
    // Start the message queue (processes all registered families)
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

    // Start all bots
    await botManager.start();
    logger.info('All bots are running. Press Ctrl+C to stop.');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ err: err.message, stack: err.stack }, 'Failed to start');
    console.error('Startup error:', err);
    process.exit(1);
  }
}

main();
