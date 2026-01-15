/**
 * Date utility functions for Sobremesa.
 */

/**
 * Get the current timestamp in ISO format.
 */
export function now(): Date {
  return new Date();
}

/**
 * Check if a date is within a time window from now.
 */
export function isWithinWindow(
  date: Date,
  windowMs: number,
  fromDate: Date = new Date(),
): boolean {
  const diff = fromDate.getTime() - date.getTime();
  return diff >= 0 && diff <= windowMs;
}

/**
 * Convert hours to milliseconds.
 */
export function hoursToMs(hours: number): number {
  return hours * 60 * 60 * 1000;
}

/**
 * Convert minutes to milliseconds.
 */
export function minutesToMs(minutes: number): number {
  return minutes * 60 * 1000;
}

/**
 * Convert days to milliseconds.
 */
export function daysToMs(days: number): number {
  return days * 24 * 60 * 60 * 1000;
}

/**
 * Get the difference between two dates in hours.
 */
export function diffInHours(date1: Date, date2: Date): number {
  return Math.abs(date1.getTime() - date2.getTime()) / (1000 * 60 * 60);
}

/**
 * Get the difference between two dates in minutes.
 */
export function diffInMinutes(date1: Date, date2: Date): number {
  return Math.abs(date1.getTime() - date2.getTime()) / (1000 * 60);
}

/**
 * Check if enough time has passed since a date.
 */
export function hasElapsed(
  since: Date,
  durationMs: number,
  fromDate: Date = new Date(),
): boolean {
  return fromDate.getTime() - since.getTime() >= durationMs;
}

/**
 * Format a date for display (ISO string without milliseconds).
 */
export function formatDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Parse a date string or return undefined if invalid.
 */
export function parseDate(value: string | Date | undefined): Date | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? undefined : parsed;
}
