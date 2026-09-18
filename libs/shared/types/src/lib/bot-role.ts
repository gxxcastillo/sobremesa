/**
 * Internal role identifiers for agents.
 * Display names are configurable via FamilyConfig (`bots.<role>.displayName`),
 * per family; never surface a `BotRole` value itself as a display name.
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
 * Inline keyboard button for Telegram inline keyboards.
 */
export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

/**
 * Inline keyboard markup for Telegram messages.
 */
export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

/**
 * Outgoing message structure for bot messaging.
 */
export interface OutgoingMessage {
  chatId: string | number;
  text: string;
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
  replyToMessageId?: number;
  /** Inline keyboard for message (Telegram-specific) */
  replyMarkup?: InlineKeyboardMarkup;
}

/**
 * Options for sending a message.
 * Re-exported from outgoing-queue for convenience.
 */
export type {
  SendOptions,
  SendDedupOptions,
  SendOutcome,
} from './outgoing-queue';
export { MessageDeliveryError } from './outgoing-queue';

/**
 * Interface for sending messages via a bot.
 * Agents should use this interface to send messages.
 *
 * Resolves with a `SendOutcome` -- 'sent', 'duplicate' (the ledger already
 * shows this dedup key delivered; not resent), or 'unconfirmed' (an
 * ambiguous 5xx/network outcome; also not resent). Throws only
 * `MessageDeliveryError` for a definitive, provably-not-delivered (4xx)
 * failure. See `outbound-send-reliability-plan.md`.
 */
export interface MessageSender {
  sendMessage(
    role: BotRole,
    message: OutgoingMessage,
    options?: import('./outgoing-queue').SendOptions,
  ): Promise<import('./outgoing-queue').SendOutcome>;
}
