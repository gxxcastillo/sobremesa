/**
 * WhatsApp Export Parser
 *
 * Parses WhatsApp .txt chat exports into structured messages.
 * Uses the whatsapp-chat-parser library for robust parsing of various formats.
 */

import * as whatsapp from 'whatsapp-chat-parser';
import type {
  ParsedMessage,
  ParseResult,
  ParsedParticipant,
} from '@sobremesa/shared-types';
import { detectLanguage, type LanguageCode } from '@sobremesa/shared-types';

// Media omitted patterns
const MEDIA_PATTERNS: Record<string, ParsedMessage['eventType']> = {
  'image omitted': 'photo',
  'video omitted': 'video',
  'audio omitted': 'audio',
  'sticker omitted': 'sticker',
  'document omitted': 'document',
  'GIF omitted': 'photo',
  '<Media omitted>': 'photo',
};

/**
 * Clean display name by removing common prefixes/suffixes.
 */
function cleanDisplayName(rawName: string): string {
  let name = rawName.trim();

  // Remove ~ prefix (broadcast list indicator)
  if (name.startsWith('~')) {
    name = name.substring(1).trim();
  }

  // Remove phone number formatting artifacts
  name = name.replace(/^\+\d+\s*/, '');

  return name || rawName;
}

/**
 * Detect event type from message content.
 */
function detectEventType(content: string): ParsedMessage['eventType'] {
  const trimmed = content.trim();

  // Check for media omitted patterns
  for (const [pattern, type] of Object.entries(MEDIA_PATTERNS)) {
    if (trimmed.includes(pattern)) {
      return type;
    }
  }

  return 'message';
}

/**
 * Generate a deterministic external event ID.
 */
function generateExternalEventId(
  timestamp: Date,
  messageNumber: number,
): string {
  return `wa-${timestamp.getTime()}-${messageNumber}`;
}

/**
 * Format a date to a raw timestamp string for storage.
 */
function formatRawTimestamp(date: Date): string {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const year = date.getFullYear() % 100;
  let hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = date.getSeconds();
  const ampm = hours >= 12 ? 'PM' : 'AM';

  if (hours > 12) hours -= 12;
  if (hours === 0) hours = 12;

  return `${month}/${day}/${year}, ${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')} ${ampm}`;
}

/**
 * Parse a WhatsApp export file content.
 */
export function parseWhatsAppExport(fileContent: string): ParseResult {
  // Use whatsapp-chat-parser library for robust parsing
  // daysFirst: false means MM/DD/YY format (US format)
  // The library auto-detects if not specified
  const rawMessages = whatsapp.parseString(fileContent, {
    parseAttachments: true,
  });

  const messages: ParsedMessage[] = [];
  const participantCounts = new Map<string, number>();
  const languageSamples: string[] = [];
  let mediaCount = 0;

  for (let i = 0; i < rawMessages.length; i++) {
    const msg = rawMessages[i];

    // Skip system messages (no author)
    if (!msg.author) {
      continue;
    }

    const timestamp = new Date(msg.date);
    const content = msg.message;
    const eventType = detectEventType(content);

    if (eventType !== 'message') {
      mediaCount++;
    }

    const parsedMessage: ParsedMessage = {
      externalEventId: generateExternalEventId(timestamp, i + 1),
      rawTimestamp: formatRawTimestamp(timestamp),
      occurredAt: timestamp,
      actorRawName: msg.author,
      actorDisplayName: cleanDisplayName(msg.author),
      eventType,
      content: content.trim(),
      messageNumber: i + 1,
    };

    messages.push(parsedMessage);

    // Track participant
    participantCounts.set(
      msg.author,
      (participantCounts.get(msg.author) || 0) + 1,
    );

    // Sample content for language detection
    if (eventType === 'message' && content.length > 20) {
      languageSamples.push(content);
    }
  }

  // Build participants list
  const participants: ParsedParticipant[] = Array.from(
    participantCounts.entries(),
  )
    .map(([rawName, messageCount]) => ({
      rawName,
      suggestedDisplayName: cleanDisplayName(rawName),
      messageCount,
    }))
    .sort((a, b) => b.messageCount - a.messageCount);

  // Detect languages from samples
  const languageVotes = new Map<LanguageCode, number>();
  for (const sample of languageSamples.slice(0, 100)) {
    const lang = detectLanguage(sample);
    languageVotes.set(lang, (languageVotes.get(lang) || 0) + 1);
  }

  const detectedLanguages = Array.from(languageVotes.entries())
    .filter(([, count]) => count >= 5)
    .sort((a, b) => b[1] - a[1])
    .map(([lang]) => lang);

  // If no clear detection, default to English
  if (detectedLanguages.length === 0) {
    detectedLanguages.push('en');
  }

  // Calculate date range
  const sortedMessages = [...messages].sort(
    (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
  );

  const dateRange = {
    start:
      sortedMessages.length > 0
        ? sortedMessages[0].occurredAt.toISOString()
        : new Date().toISOString(),
    end:
      sortedMessages.length > 0
        ? sortedMessages[sortedMessages.length - 1].occurredAt.toISOString()
        : new Date().toISOString(),
  };

  return {
    messages,
    stats: {
      messageCount: messages.length,
      mediaCount,
      dateRange,
      participantCount: participants.length,
    },
    detectedLanguages,
    participants,
  };
}

/**
 * Parse timestamp with a specific timezone.
 * Used on the server to re-parse timestamps with the configured family timezone.
 *
 * Strategy: Use Date.UTC as a reference point (no server-local TZ dependency),
 * then use Intl.DateTimeFormat to find the UTC offset for the target timezone
 * at the given moment.
 */
export function parseTimestampWithTimezone(
  rawTimestamp: string,
  timezone: string,
): Date {
  // Parse the raw timestamp parts - handle both 12h and 24h formats
  const match = rawTimestamp.match(
    /(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?/i,
  );

  if (!match) {
    throw new Error(`Invalid timestamp format: ${rawTimestamp}`);
  }

  const [, monthStr, dayStr, yearStr, hourStr, minuteStr, secondStr, ampm] =
    match;

  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);
  let year = parseInt(yearStr, 10);
  let hours = parseInt(hourStr, 10);
  const minutes = parseInt(minuteStr, 10);
  const seconds = secondStr ? parseInt(secondStr, 10) : 0;

  if (year < 100) {
    year += year < 50 ? 2000 : 1900;
  }

  // Handle AM/PM if present
  if (ampm) {
    const isPM = ampm.toUpperCase() === 'PM';
    if (isPM && hours !== 12) {
      hours += 12;
    } else if (!isPM && hours === 12) {
      hours = 0;
    }
  }

  // Create a UTC reference with the parsed time components
  const utcGuess = Date.UTC(year, month - 1, day, hours, minutes, seconds);

  // Find what this UTC moment displays as in the target timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(new Date(utcGuess));
  const getPart = (type: string) =>
    parseInt(parts.find((p) => p.type === type)?.value || '0', 10);

  // What does our UTC guess look like in the target timezone?
  const displayedAsUtc = Date.UTC(
    getPart('year'),
    getPart('month') - 1,
    getPart('day'),
    getPart('hour'),
    getPart('minute'),
    getPart('second'),
  );

  // The offset between UTC and the target timezone at this moment
  const tzOffsetMs = displayedAsUtc - utcGuess;

  // Subtract the offset: we want the UTC time that, when displayed
  // in the target timezone, shows our parsed components
  return new Date(utcGuess - tzOffsetMs);
}
