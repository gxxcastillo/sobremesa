/**
 * Supported language codes.
 */
export type LanguageCode = 'es' | 'en' | 'mixed' | string;

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
 * Detect if text contains mixed languages.
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

  if (spanishScore > 0 && englishScore > 0) {
    const ratio = Math.min(spanishScore, englishScore) / Math.max(spanishScore, englishScore);
    if (ratio > 0.3) {
      return 'mixed';
    }
  }

  if (spanishScore > englishScore) {
    return 'es';
  }

  return 'en';
}
