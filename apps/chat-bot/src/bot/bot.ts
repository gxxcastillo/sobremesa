import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { createLogger } from '@sobremesa/shared-utils';
import { MessageIngester } from './ingester.js';
import { FamilyRepository } from '@sobremesa/database';

const logger = createLogger({ name: 'bot' });

export interface BotConfig {
  token: string;
}

export async function createBot(config: BotConfig): Promise<Telegraf> {
  const bot = new Telegraf(config.token);

  // Get or create default family
  const familyRepo = new FamilyRepository();
  let family = await familyRepo.findDefault();
  if (!family) {
    logger.info('No default family found, creating one');
    family = await familyRepo.create('Default Family', {});
  }

  const ingester = new MessageIngester(family.id);

  // Log bot info
  bot.use(async (ctx, next) => {
    const start = Date.now();
    await next();
    const duration = Date.now() - start;
    logger.debug(
      {
        updateType: ctx.updateType,
        duration,
        from: ctx.from?.username || ctx.from?.id,
      },
      'Update processed'
    );
  });

  // Handle text messages
  bot.on(message('text'), async (ctx) => {
    try {
      await ingester.ingestTextMessage(ctx);
    } catch (error) {
      logger.error({ error, messageId: ctx.message.message_id }, 'Failed to ingest text message');
    }
  });

  // Handle photos
  bot.on(message('photo'), async (ctx) => {
    try {
      await ingester.ingestPhotoMessage(ctx);
    } catch (error) {
      logger.error({ error, messageId: ctx.message.message_id }, 'Failed to ingest photo message');
    }
  });

  // Handle documents
  bot.on(message('document'), async (ctx) => {
    try {
      await ingester.ingestDocumentMessage(ctx);
    } catch (error) {
      logger.error({ error, messageId: ctx.message.message_id }, 'Failed to ingest document message');
    }
  });

  // Handle new chat members
  bot.on('chat_member', async (ctx) => {
    if (ctx.chatMember.new_chat_member.status === 'member') {
      logger.info(
        { userId: ctx.chatMember.new_chat_member.user.id },
        'New member joined'
      );
    }
  });

  // Error handling
  bot.catch((err, ctx) => {
    logger.error({ error: err, updateType: ctx.updateType }, 'Bot error');
  });

  logger.info('Bot created and configured');
  return bot;
}
