/**
 * Onboarding messages and timezone keyboard for user onboarding flow.
 */

import {
  type SupportedLanguage,
  isSupportedLanguage,
  DEFAULT_LANGUAGE,
} from '@sobremesa/shared-types';

/**
 * Telegram InlineKeyboardMarkup for timezone selection.
 * Common timezones organized by region.
 */
export const TIMEZONE_KEYBOARD = {
  inline_keyboard: [
    [
      { text: '🇺🇸 Pacific', callback_data: 'tz:America/Los_Angeles' },
      { text: '🇺🇸 Mountain', callback_data: 'tz:America/Denver' },
    ],
    [
      { text: '🇺🇸 Central', callback_data: 'tz:America/Chicago' },
      { text: '🇺🇸 Eastern', callback_data: 'tz:America/New_York' },
    ],
    [
      { text: '🇲🇽 Mexico City', callback_data: 'tz:America/Mexico_City' },
      { text: '🇧🇷 São Paulo', callback_data: 'tz:America/Sao_Paulo' },
    ],
    [
      { text: '🇬🇧 London', callback_data: 'tz:Europe/London' },
      { text: '🇪🇺 Madrid/Paris', callback_data: 'tz:Europe/Madrid' },
    ],
    [{ text: '🌍 Other...', callback_data: 'tz:other' }],
  ],
};

/**
 * Additional timezones shown when user selects "Other".
 */
export const TIMEZONE_KEYBOARD_OTHER = {
  inline_keyboard: [
    [
      { text: '🇯🇵 Tokyo', callback_data: 'tz:Asia/Tokyo' },
      { text: '🇨🇳 Shanghai', callback_data: 'tz:Asia/Shanghai' },
    ],
    [
      { text: '🇮🇳 Mumbai', callback_data: 'tz:Asia/Kolkata' },
      { text: '🇦🇺 Sydney', callback_data: 'tz:Australia/Sydney' },
    ],
    [
      { text: '🇷🇺 Moscow', callback_data: 'tz:Europe/Moscow' },
      { text: '🇿🇦 Johannesburg', callback_data: 'tz:Africa/Johannesburg' },
    ],
    [
      { text: '🇦🇪 Dubai', callback_data: 'tz:Asia/Dubai' },
      { text: '🇸🇬 Singapore', callback_data: 'tz:Asia/Singapore' },
    ],
    [{ text: '« Back', callback_data: 'tz:back' }],
  ],
};

/**
 * Display names for timezone codes.
 */
export const TIMEZONE_DISPLAY_NAMES: Record<string, string> = {
  'America/Los_Angeles': 'Pacific Time (US)',
  'America/Denver': 'Mountain Time (US)',
  'America/Chicago': 'Central Time (US)',
  'America/New_York': 'Eastern Time (US)',
  'America/Mexico_City': 'Mexico City',
  'America/Sao_Paulo': 'São Paulo (Brazil)',
  'Europe/London': 'London (UK)',
  'Europe/Madrid': 'Madrid/Paris',
  'Asia/Tokyo': 'Tokyo (Japan)',
  'Asia/Shanghai': 'Shanghai (China)',
  'Asia/Kolkata': 'Mumbai (India)',
  'Australia/Sydney': 'Sydney (Australia)',
  'Europe/Moscow': 'Moscow (Russia)',
  'Africa/Johannesburg': 'Johannesburg (South Africa)',
  'Asia/Dubai': 'Dubai (UAE)',
  'Asia/Singapore': 'Singapore',
};

export interface OnboardingMessages {
  dmGreeting: (familyName: string) => string;
  timezoneQuestion: string;
  timezoneConfirmation: (timezone: string) => string;
  groupReminder: (userName: string) => string;
  dmFailed: string;
  otherTimezones: string;
}

const MESSAGES_EN: OnboardingMessages = {
  dmGreeting: (familyName) => `Hi! Thanks for joining the ${familyName} chat.`,
  timezoneQuestion:
    "To help me understand dates you mention (like 'tomorrow' or 'next week'), what's your timezone?",
  timezoneConfirmation: (timezone) =>
    `Got it! I'll use ${timezone} for your messages.`,
  groupReminder: (userName) =>
    `Hey ${userName}, send me a DM to set up your timezone! Just tap on my name and press Start.`,
  dmFailed:
    "I couldn't send you a DM. Please start a chat with me first by tapping on my name and pressing Start.",
  otherTimezones: 'Here are more timezone options:',
};

const MESSAGES_ES: OnboardingMessages = {
  dmGreeting: (familyName) =>
    `¡Hola! Gracias por unirte al chat de ${familyName}.`,
  timezoneQuestion:
    "Para ayudarme a entender las fechas que mencionas (como 'mañana' o 'la próxima semana'), ¿cuál es tu zona horaria?",
  timezoneConfirmation: (timezone) =>
    `¡Entendido! Usaré ${timezone} para tus mensajes.`,
  groupReminder: (userName) =>
    `Oye ${userName}, ¡envíame un mensaje directo para configurar tu zona horaria! Solo toca mi nombre y presiona Iniciar.`,
  dmFailed:
    'No pude enviarte un mensaje directo. Por favor, inicia un chat conmigo primero tocando mi nombre y presionando Iniciar.',
  otherTimezones: 'Aquí hay más opciones de zona horaria:',
};

const MESSAGES: Record<SupportedLanguage, OnboardingMessages> = {
  en: MESSAGES_EN,
  es: MESSAGES_ES,
};

/**
 * Get onboarding messages for a specific language.
 * Falls back to English if language is not supported.
 */
export function getOnboardingMessages(
  language: SupportedLanguage | string,
): OnboardingMessages {
  const lang = isSupportedLanguage(language) ? language : DEFAULT_LANGUAGE;
  return MESSAGES[lang];
}

/**
 * Format the onboarding DM message with timezone question.
 */
export function formatOnboardingDm(
  language: SupportedLanguage | string,
  familyName: string,
): string {
  const m = getOnboardingMessages(language);
  return [m.dmGreeting(familyName), '', m.timezoneQuestion].join('\n');
}

/**
 * Format the timezone confirmation message.
 */
export function formatTimezoneConfirmation(
  language: SupportedLanguage | string,
  timezone: string,
): string {
  const m = getOnboardingMessages(language);
  const displayName = TIMEZONE_DISPLAY_NAMES[timezone] || timezone;
  return m.timezoneConfirmation(displayName);
}

/**
 * Format the group reminder message when DM fails.
 */
export function formatGroupReminder(
  language: SupportedLanguage | string,
  userName: string,
): string {
  const m = getOnboardingMessages(language);
  return m.groupReminder(userName);
}
