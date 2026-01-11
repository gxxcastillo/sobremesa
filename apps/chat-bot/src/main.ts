import 'dotenv/config';
import { createBot } from './bot/bot.js';
import { createLogger } from '@sobremesa/shared-utils';

const logger = createLogger({ name: 'chat-bot' });

async function main() {
  logger.info('Starting Sobremesa chat bot...');

  // Validate required environment variables
  const token = process.env['TELEGRAM_BOT_TOKEN'];
  if (!token) {
    logger.error('TELEGRAM_BOT_TOKEN environment variable is required');
    process.exit(1);
  }

  try {
    const bot = await createBot({ token });

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Received shutdown signal');
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
