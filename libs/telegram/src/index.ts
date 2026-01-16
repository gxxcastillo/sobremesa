export { BotManager } from './lib/bot-manager';
export { ChatbotHandler } from './lib/chatbot';
export type {
  BotRole,
  BotConfig,
  BotManagerConfig,
  BotHandler,
  OutgoingMessage,
  MessageSpacingConfig,
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
