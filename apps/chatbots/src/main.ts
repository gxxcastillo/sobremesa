import Anthropic from '@anthropic-ai/sdk';
import { createLogger, logAlert, type LogLevel } from '@sobremesa/shared-utils';
import {
  loadAIConfig,
  createAIProviderFactory,
  validateConfig,
  SpendBudget,
  BudgetedProvider,
  type AIProvider,
} from '@sobremesa/ai-provider';
import { MessageQueue } from '@sobremesa/queue';
import { BotManager } from '@sobremesa/telegram';
import { buildMessagePipeline, type PipelineStage } from '@sobremesa/pipeline';
import {
  createDatabaseClient,
  ProcessingQueueRepository,
} from '@sobremesa/database';

const logger = createLogger({
  name: 'chatbots',
  level: (process.env['LOG_LEVEL'] as LogLevel) || 'info',
});

function validateEnv(): {
  token: string;
  anthropicApiKey?: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  studioUrl: string;
} {
  const missing: string[] = [];

  const token = process.env['TELEGRAM_BOT_TOKEN'];
  if (!token) missing.push('TELEGRAM_BOT_TOKEN');

  const supabaseUrl = process.env['SUPABASE_URL'];
  if (!supabaseUrl) missing.push('SUPABASE_URL');

  const supabaseAnonKey = process.env['SUPABASE_ANON_KEY'];
  if (!supabaseAnonKey) missing.push('SUPABASE_ANON_KEY');

  const supabaseServiceRoleKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (!supabaseServiceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');

  if (!process.env['ACCESS_PASS_SECRET']) missing.push('ACCESS_PASS_SECRET');

  if (missing.length > 0) {
    logger.error({ missing }, 'Missing required environment variables');
    process.exit(1);
  }

  const anthropicApiKey = process.env['ANTHROPIC_API_KEY'];
  if (!anthropicApiKey) {
    logger.warn('ANTHROPIC_API_KEY not set - agents will not process messages');
  }

  const studioUrl = process.env['STUDIO_URL'] || 'https://studio.sobremesa.app';

  return {
    token: token as string,
    anthropicApiKey,
    supabaseUrl: supabaseUrl as string,
    supabaseAnonKey: supabaseAnonKey as string,
    supabaseServiceRoleKey: supabaseServiceRoleKey as string,
    studioUrl,
  };
}

async function main() {
  logger.info('Starting Sobremesa conversation gateway...');

  const {
    token,
    anthropicApiKey,
    supabaseUrl,
    supabaseAnonKey,
    supabaseServiceRoleKey,
    studioUrl,
  } = validateEnv();

  // Initialize database client
  logger.debug('Creating database client...');
  const dbClient = createDatabaseClient({
    url: supabaseUrl,
    anonKey: supabaseAnonKey,
    serviceRoleKey: supabaseServiceRoleKey,
  });

  try {
    logger.debug('Creating BotManager...');
    const botManager = new BotManager({ token, dbClient, studioUrl, logger });

    // Get bot info for mention detection
    logger.debug('Fetching bot info...');
    const botInfo = await botManager.getBot().telegram.getMe();
    logger.info({ username: botInfo.username }, 'Bot info retrieved');

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

    // Daily LLM spend budget (hardening H), in estimated USD. Absent =
    // unlimited. Every agent provider is metered: Anthropic models missing
    // from the pricing table are charged the most expensive known rate;
    // other (local, OpenAI-compatible) models are free unless the table
    // prices them. An invalid value fails startup rather than silently
    // running unbounded.
    const rawBudget = process.env['DAILY_SPEND_BUDGET_USD'];
    let budget: SpendBudget | undefined;
    if (rawBudget !== undefined && rawBudget.trim() !== '') {
      const dailyLimitUsd = Number(rawBudget);
      if (!Number.isFinite(dailyLimitUsd) || dailyLimitUsd <= 0) {
        throw new Error(
          `DAILY_SPEND_BUDGET_USD must be a positive dollar amount, got "${rawBudget}"`,
        );
      }
      budget = new SpendBudget({
        dailyLimitUsd,
        onExhausted: ({ usedUsd, limitUsd, day }) =>
          logAlert(
            logger,
            'spend_limit_reached',
            { usedUsd, limitUsd, day },
            'Daily LLM spend budget reached; queue paused until the next UTC day (items stay queued)',
          ),
      });
      logger.info({ dailyLimitUsd }, 'Daily LLM spend budget enabled');
    }
    // When the storyFollowup stage is activated, its `followup` provider
    // must go through metered() too.
    const metered = (provider: AIProvider): AIProvider =>
      budget
        ? new BudgetedProvider(
            provider,
            budget,
            provider.name === 'anthropic' ? 'conservative' : 'free',
          )
        : provider;

    // Admin doesn't require AI; the rest of the pipeline does. When no AI
    // provider is configured, only Admin gets wired -- messages still get
    // admin handling, but nothing reaches Scribe/Registrar/Historian.
    logger.debug('Building message pipeline...');
    const stages = new Set<PipelineStage>(['admin']);
    if (hasAIProvider) {
      stages.add('router');
      stages.add('filter');
      stages.add('imageLinker');
      stages.add('scribe');
      stages.add('registrar');
      stages.add('historian');
      stages.add('facilitatorNudge');
    }

    const processor = buildMessagePipeline({
      dbClient,
      stages,
      messageSender: botManager,
      botUsername: botInfo.username,
      // 24h between any question asked -- story-followups-plan.md D2/#5;
      // was 5, an override that made the constructor's 60-min default
      // (F0's own fix, see spec/agent-pipeline.md) unreachable in
      // production.
      minMinutesBetweenQuestions: 1440,
      logger,
      providers: hasAIProvider
        ? {
            intern: metered(aiFactory.getProviderForAgent('intern')),
            scribe: metered(aiFactory.getProviderForAgent('scribe')),
            historian: metered(aiFactory.getProviderForAgent('historian')),
            facilitator: metered(aiFactory.getProviderForAgent('facilitator')),
          }
        : {},
      models: hasAIProvider
        ? {
            intern: aiFactory.getModelForAgent('intern'),
            scribe: aiFactory.getModelForAgent('scribe'),
            historian: aiFactory.getModelForAgent('historian'),
            facilitator: aiFactory.getModelForAgent('facilitator'),
          }
        : {},
    });
    logger.info(
      { hasAI: hasAIProvider, stages: [...stages] },
      'Message pipeline built',
    );

    logger.debug('Starting MessageQueue...');
    const queue = new MessageQueue({
      repository: new ProcessingQueueRepository(dbClient),
      // Never claim an 'import'-owned row: those belong to import's own
      // scoped drain (libs/import/src/lib/import-drain.ts), not this
      // always-on poller. Claiming one here would run the full live stage
      // set (admin/Historian/Facilitator included) on a historical import
      // message -- import deliberately never wires those stages, so a
      // historical message must never send an outbound message or answer a
      // question.
      queueOptions: { intentFilter: ['live'] },
    });
    queue.setHandler(processor.createHandler());
    if (budget) queue.setGate(() => !budget.isExhausted());
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
