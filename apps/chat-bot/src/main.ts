import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { createBot } from './bot/bot.js';
import { createLogger } from '@sobremesa/shared-utils';
import { MessageQueue, MessageProcessor } from '@sobremesa/queue';
import { FamilyRepository } from '@sobremesa/database';
import { ScribeAgent } from '@sobremesa/agents-scribe';
import { RegistrarAgent } from '@sobremesa/agents-registrar';

const logger = createLogger({ name: 'chat-bot' });

async function main() {
  logger.info('Starting Sobremesa chat bot...');

  // Validate required environment variables
  const token = process.env['TELEGRAM_BOT_TOKEN'];
  if (!token) {
    logger.error('TELEGRAM_BOT_TOKEN environment variable is required');
    process.exit(1);
  }

  const anthropicApiKey = process.env['ANTHROPIC_API_KEY'];
  if (!anthropicApiKey) {
    logger.warn('ANTHROPIC_API_KEY not set - Scribe agent will not process messages');
  }

  try {
    const bot = await createBot({ token });

    // Get default family for queue processing
    const familyRepo = new FamilyRepository();
    let family = await familyRepo.findDefault();
    if (!family) {
      family = await familyRepo.create('Default Family', {});
    }

    // Set up message processing pipeline
    const processor = new MessageProcessor();

    // Configure Scribe agent if API key is available
    if (anthropicApiKey) {
      const anthropic = new Anthropic({ apiKey: anthropicApiKey });
      const scribe = new ScribeAgent({ anthropic });
      const registrar = new RegistrarAgent();

      processor.setScribe((eventId, familyId) => scribe.process(eventId, familyId));
      processor.setRegistrar((model, familyId) => registrar.persist(model, familyId));

      logger.info('Scribe and Registrar agents configured');
    }

    // Start the message queue
    const queue = new MessageQueue();
    queue.setHandler(processor.createHandler());
    await queue.start(family.id);
    logger.info({ familyId: family.id }, 'Message queue started');

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Received shutdown signal');
      await queue.stop();
      bot.stop(signal);
      process.exit(0);
    };

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));

    // Start the bot
    await bot.launch();
    logger.info('Bot is running. Press Ctrl+C to stop.');
  } catch (error) {
    logger.error({ error }, 'Failed to start bot');
    process.exit(1);
  }
}

main();
