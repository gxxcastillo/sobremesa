export { BotManager } from './lib/bot-manager.js';
export { ScribeBotHandler } from './lib/scribe-bot.js';
export { AdminBotHandler } from './lib/admin-bot.js';
export { FacilitatorBotHandler } from './lib/facilitator-bot.js';
export type {
  BotRole,
  BotConfig,
  BotManagerConfig,
  BotHandler,
  OutgoingMessage,
} from './lib/types.js';

// Re-export from @sobremesa/ingester for convenience
export {
  MessageIngester,
  type ActorInfo,
  type BaseMessageInput,
  type TextMessageInput,
  type PhotoMessageInput,
  type DocumentMessageInput,
} from '@sobremesa/ingester';
