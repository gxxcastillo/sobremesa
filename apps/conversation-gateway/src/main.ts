import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '@sobremesa/shared-utils';
import { MessageQueue, MessageProcessor } from '@sobremesa/queue';
import { BotManager } from '@sobremesa/telegram';
import { ScribeAgent } from '@sobremesa/agents-scribe';
import { RegistrarAgent } from '@sobremesa/agents-registrar';

const logger = createLogger({ name: 'conversation-gateway' });

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

    // Configure Scribe agent if API key is available
    if (anthropicApiKey) {
      logger.debug('Configuring Scribe and Registrar agents...');
      const anthropic = new Anthropic({ apiKey: anthropicApiKey });
      const scribe = new ScribeAgent({ anthropic });
      const registrar = new RegistrarAgent();

      processor.setScribe((eventId, familyId) => scribe.process(eventId, familyId));
      processor.setRegistrar((model, familyId) => registrar.persist(model, familyId));

      logger.info('Scribe and Registrar agents configured');
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
