/**
 * Internal role identifiers for agents.
 * Display names are configurable via SobremesaConfig.
 */
export type BotRole =
  | 'facilitator'
  | 'admin'
  | 'scribe'
  | 'curator'
  | 'historian'
  | 'registrar'
  | 'chatbot';

/**
 * Roles that are visible to family members in chat.
 */
export const VISIBLE_ROLES = ['facilitator', 'admin'] as const;

/**
 * Roles that are hidden (backend processing only).
 */
export const HIDDEN_ROLES = ['scribe', 'curator', 'registrar'] as const;

/**
 * Roles that call the Claude API.
 */
export const AI_ROLES = ['facilitator', 'admin', 'scribe', 'curator'] as const;

export type VisibleRole = (typeof VISIBLE_ROLES)[number];
export type HiddenRole = (typeof HIDDEN_ROLES)[number];
export type AIRole = (typeof AI_ROLES)[number];

/**
 * Outgoing message structure for bot messaging.
 */
export interface OutgoingMessage {
  chatId: string | number;
  text: string;
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
  replyToMessageId?: number;
}

/**
 * Options for sending a message.
 * Re-exported from outgoing-queue for convenience.
 */
export type { SendOptions } from './outgoing-queue';

/**
 * Interface for sending messages via a bot.
 * Agents should use this interface to send messages.
 */
export interface MessageSender {
  sendMessage(
    role: BotRole,
    message: OutgoingMessage,
    options?: import('./outgoing-queue').SendOptions,
  ): Promise<number>;
}
