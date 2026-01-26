/**
 * Languages the application supports for bot responses and UI.
 * ISO 639-1 codes.
 */
export type SupportedLanguage = 'en' | 'es';

/**
 * Default language when none is configured.
 */
export const DEFAULT_LANGUAGE: SupportedLanguage = 'en';

/**
 * Map of supported languages to their locale strings for formatting.
 */
export const LANGUAGE_LOCALES: Record<SupportedLanguage, string> = {
  en: 'en-US',
  es: 'es-ES',
};

/**
 * Check if a string is a supported language.
 */
export function isSupportedLanguage(lang: string): lang is SupportedLanguage {
  return lang === 'en' || lang === 'es';
}

/**
 * Language codes for content detection (broader than SupportedLanguage)
 */
export type LanguageCode = 'es' | 'en' | 'unknown';

/**
 * Language configuration for a family.
 */
export interface LanguageConfig {
  primary: LanguageCode;
  secondary: LanguageCode[];
}

/**
 * Default language configuration (Spanish-English bilingual).
 */
export const DEFAULT_LANGUAGE_CONFIG: LanguageConfig = {
  primary: 'es',
  secondary: ['en'],
};

/**
 * Content stored in original language with optional translations.
 */
export interface BilingualContent {
  original: string;
  languageOriginal: LanguageCode;
  translations?: Record<LanguageCode, string>;
}

/**
 * Detect language used in "text"
 */
export function detectLanguage(text: string): LanguageCode {
  // Simple heuristic - count Spanish-specific characters and common words
  const spanishPatterns = /[áéíóúñ¿¡]/gi;
  const spanishWords =
    /\b(el|la|los|las|de|en|que|es|un|una|por|con|para|se|del|al)\b/gi;
  const englishWords =
    /\b(the|a|an|is|are|was|were|be|been|have|has|had|do|does|did|will|would|could|should)\b/gi;

  const spanishChars = (text.match(spanishPatterns) || []).length;
  const spanishWordCount = (text.match(spanishWords) || []).length;
  const englishWordCount = (text.match(englishWords) || []).length;

  const spanishScore = spanishChars + spanishWordCount * 2;
  const englishScore = englishWordCount * 2;

  if (spanishScore > englishScore) {
    return 'es';
  }

  return 'en';
}
