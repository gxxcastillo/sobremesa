/**
 * Telegram Login Widget verification
 *
 * Verifies the HMAC hash from Telegram Login Widget to ensure
 * the data is authentic and hasn't been tampered with.
 *
 * @see https://core.telegram.org/widgets/login#checking-authorization
 */

import { createHmac, createHash } from 'crypto';
import type { TelegramLoginData } from './types';

/**
 * Maximum age of auth_date (24 hours in seconds)
 */
const MAX_AUTH_AGE_SECONDS = 86400;

/**
 * Verify Telegram Login Widget data using HMAC-SHA256
 *
 * @param data - The data received from Telegram Login Widget
 * @param botToken - Your Telegram bot token
 * @returns true if the data is valid and not expired
 */
export function verifyTelegramLogin(
  data: TelegramLoginData,
  botToken: string,
): boolean {
  // Check if auth_date is not too old (24 hours)
  const now = Math.floor(Date.now() / 1000);
  if (now - data.auth_date > MAX_AUTH_AGE_SECONDS) {
    return false;
  }

  // Extract hash from data
  const { hash, ...dataWithoutHash } = data;

  // Create data-check-string by sorting keys alphabetically
  // and joining with newline
  const dataCheckString = Object.keys(dataWithoutHash)
    .sort()
    .map(
      (key) => `${key}=${dataWithoutHash[key as keyof typeof dataWithoutHash]}`,
    )
    .join('\n');

  // Create secret key from bot token using SHA256
  const secretKey = createHash('sha256').update(botToken).digest();

  // Calculate HMAC-SHA256
  const calculatedHash = createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  // Compare hashes
  return calculatedHash === hash;
}

/**
 * Parse Telegram Login Widget callback URL parameters
 *
 * @param params - URL search params from callback
 * @returns Parsed TelegramLoginData or null if invalid
 */
export function parseTelegramLoginParams(
  params: URLSearchParams,
): TelegramLoginData | null {
  const id = params.get('id');
  const firstName = params.get('first_name');
  const authDate = params.get('auth_date');
  const hash = params.get('hash');

  // Required fields
  if (!id || !firstName || !authDate || !hash) {
    return null;
  }

  const parsedId = parseInt(id, 10);
  const parsedAuthDate = parseInt(authDate, 10);

  if (isNaN(parsedId) || isNaN(parsedAuthDate)) {
    return null;
  }

  return {
    id: parsedId,
    first_name: firstName,
    last_name: params.get('last_name') || undefined,
    username: params.get('username') || undefined,
    photo_url: params.get('photo_url') || undefined,
    auth_date: parsedAuthDate,
    hash,
  };
}

/**
 * Build display name from Telegram user data
 */
export function buildDisplayName(
  firstNameOrData: string | TelegramLoginData,
  lastName?: string,
): string {
  // If passed TelegramLoginData object
  if (typeof firstNameOrData === 'object') {
    const data = firstNameOrData;
    if (data.last_name) {
      return `${data.first_name} ${data.last_name}`;
    }
    return data.first_name;
  }

  // If passed individual strings
  if (lastName) {
    return `${firstNameOrData} ${lastName}`;
  }
  return firstNameOrData;
}
