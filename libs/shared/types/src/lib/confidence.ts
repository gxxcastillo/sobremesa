/**
 * Confidence levels for claims and extracted data.
 */
export type Confidence = 'high' | 'medium' | 'low';

/**
 * Certainty language indicators from source text.
 */
export const CERTAINTY_INDICATORS = {
  high: [
    'definitely',
    'certainly',
    'I know',
    'I remember clearly',
    'for sure',
    'sin duda',
    'definitivamente',
    'seguro',
  ],
  medium: [
    'I think',
    'probably',
    'likely',
    'I believe',
    'creo que',
    'probablemente',
    'me parece',
  ],
  low: [
    'maybe',
    'possibly',
    'might have',
    "I'm not sure",
    'quizás',
    'tal vez',
    'no estoy seguro',
    'puede ser',
  ],
} as const;

/**
 * Map certainty language to confidence level.
 */
export function detectConfidence(text: string): Confidence {
  const lowerText = text.toLowerCase();

  for (const indicator of CERTAINTY_INDICATORS.high) {
    if (lowerText.includes(indicator.toLowerCase())) {
      return 'high';
    }
  }

  for (const indicator of CERTAINTY_INDICATORS.low) {
    if (lowerText.includes(indicator.toLowerCase())) {
      return 'low';
    }
  }

  for (const indicator of CERTAINTY_INDICATORS.medium) {
    if (lowerText.includes(indicator.toLowerCase())) {
      return 'medium';
    }
  }

  return 'medium';
}
