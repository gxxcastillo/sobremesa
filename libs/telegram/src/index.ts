export { BotManager } from './lib/bot-manager';
export { ScribeBotHandler } from './lib/scribe-bot';
export { AdminBotHandler } from './lib/admin-bot';
export { FacilitatorBotHandler } from './lib/facilitator-bot';
export type {
  BotRole,
  BotConfig,
  BotManagerConfig,
  BotHandler,
  OutgoingMessage,
} from './lib/types';

// Re-export from @sobremesa/ingester for convenience
export {
  MessageIngester,
  type ActorInfo,
  type BaseMessageInput,
  type TextMessageInput,
  type PhotoMessageInput,
  type DocumentMessageInput,
} from '@sobremesa/ingester';
