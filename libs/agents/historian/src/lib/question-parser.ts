import type { QuestionType, ParsedQuestion } from './types';

/**
 * Patterns for detecting question types.
 * Order matters - more specific patterns should come first.
 */
const QUESTION_TYPE_PATTERNS: Array<{
  type: QuestionType;
  patterns: RegExp[];
}> = [
  // Verification should come early to catch "is it true" before relationship catches family terms
  {
    type: 'verification',
    patterns: [
      /is it true/i,
      /(?:did|does|was|were|is|are) .+ really/i,
      /(?:confirm|verify|check)/i,
      /true that/i,
    ],
  },
  // Story should come before person_info to catch "tell me about ... story"
  {
    type: 'story',
    patterns: [
      /(?:what is|what's|tell me) the story/i,
      /\bstory\b/i, // Any mention of "story" as a word
      /how did .+ (?:start|begin|happen)/i,
      /(?:tale|anecdote|history) (?:of|about)/i,
    ],
  },
  {
    type: 'timeline',
    patterns: [
      /when did/i,
      /\bwhen\b.*\b(?:move|moved|arrive|arrived|come|came|go|went|happen|happened)\b/i, // "when" + action verb
      /what year/i,
      /how long ago/i,
      /what (?:date|time)/i,
      /(?:before|after) .+ (?:happen|occur)/i,
      /timeline/i,
    ],
  },
  {
    type: 'location',
    patterns: [
      /where (?:did|was|were|is|are)/i,
      /what (?:place|city|country|town|address)/i,
      /(?:live|lived|born|grew up|raised) (?:in|at)/i,
      /(?:from|came from|emigrated from|immigrated to)/i,
      /location/i,
    ],
  },
  {
    type: 'event',
    patterns: [
      /what happened/i,
      /tell me about the .+ (?:wedding|funeral|party|celebration|trip)/i,
      /(?:event|occasion|ceremony)/i,
      /what (?:took place|occurred)/i,
    ],
  },
  // Relationship patterns - be more specific to avoid matching just family terms
  {
    type: 'relationship',
    patterns: [
      /how (?:is|are|was|were) .+ related/i,
      /(?:what is|what's) the relationship/i,
      /(?:is|are|was|were) .+ (?:related|family|kin)/i,
      /(?:who is|who's) .+ to .+/i,
      /relationship between/i,
    ],
  },
  // Person info should come after more specific patterns
  {
    type: 'person_info',
    patterns: [
      /(?:tell me|what do (?:you|we) know) about (?:(?:uncle|aunt|grandpa|grandma|grandfather|grandmother|cousin)\s+)?\w+/i,
      /who (?:is|was) (\w+)/i,
      /(?:information|info) (?:on|about) (\w+)/i,
      /what (?:can you tell me|do we know) about (\w+)/i,
      /(?:do you know|does anyone know) (?:anything )?about/i, // "Do you know about X"
      /(?:uncle|aunt|grandpa|grandma|grandfather|grandmother|cousin)\s+[A-Z]/i, // Family term + capitalized name
    ],
  },
];

/**
 * Common family-related terms to extract as entities.
 */
const FAMILY_TERMS = [
  'grandpa',
  'grandma',
  'grandfather',
  'grandmother',
  'dad',
  'mom',
  'father',
  'mother',
  'uncle',
  'aunt',
  'cousin',
  'brother',
  'sister',
  'son',
  'daughter',
  'husband',
  'wife',
  'spouse',
];

/**
 * Time-related terms to extract.
 */
const TIME_PATTERNS = [
  /\b(\d{4})\b/, // Years like 1920
  /\b(\d{4}s)\b/, // Decades like 1920s
  /\b(19\d{2}|20\d{2})\b/, // 20th/21st century years
  /\b(last|next|this) (year|month|decade|century)\b/i,
  /\b(early|mid|late) (\d{4}s|\d{2}th century)\b/i,
  /\b(before|after|during) (the war|ww[i12]|world war)/i,
];

/**
 * Check if a text contains a question.
 */
export function isQuestion(text: string): boolean {
  const trimmed = text.trim();

  // Ends with question mark
  if (trimmed.endsWith('?')) {
    return true;
  }

  // Starts with question words
  const questionStarters =
    /^(who|what|when|where|why|how|is|are|was|were|did|do|does|can|could|would|will|tell me|do you know|does anyone)/i;
  if (questionStarters.test(trimmed)) {
    return true;
  }

  // "I wonder" is an implicit question
  if (/^i wonder\b/i.test(trimmed)) {
    return true;
  }

  // Contains question-like phrases (but NOT "I remember" which is a statement)
  // Only match "do you remember", "does anyone remember", etc.
  const questionPhrases =
    /\b(do you|does anyone|can you|could you)\s+(know about|remember|recall|tell me about)\b/i;
  if (questionPhrases.test(trimmed)) {
    return true;
  }

  // "Tell me about" is a request for information (implicit question)
  if (/\btell me about\b/i.test(trimmed)) {
    return true;
  }

  // "I want to know" is an implicit question
  if (/\bi want to know\b/i.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Detect the type of question.
 */
export function detectQuestionType(text: string): QuestionType {
  for (const { type, patterns } of QUESTION_TYPE_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        return type;
      }
    }
  }

  return 'general';
}

/**
 * Extract entity references from the question.
 */
export function extractEntities(text: string): string[] {
  const entities: string[] = [];

  // Extract capitalized words (likely names)
  const capitalizedWords = text.match(/\b[A-Z][a-z]+\b/g) || [];
  for (const word of capitalizedWords) {
    // Skip common words that happen to be capitalized
    const skipWords = [
      'I',
      'The',
      'A',
      'An',
      'Is',
      'Are',
      'Was',
      'Were',
      'What',
      'When',
      'Where',
      'Who',
      'How',
      'Tell',
      'Do',
      'Does',
      'Did',
      'Can',
      'Could',
    ];
    if (!skipWords.includes(word)) {
      entities.push(word);
    }
  }

  // Extract family term + name patterns (e.g., "grandpa Abraham")
  for (const term of FAMILY_TERMS) {
    const pattern = new RegExp(`${term}\\s+([A-Z][a-z]+)`, 'gi');
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      if (match[1]) {
        entities.push(match[1]);
      }
    }
  }

  // Deduplicate
  return [...new Set(entities)];
}

/**
 * Extract time references from the question.
 */
export function extractTimeReferences(text: string): string[] {
  const timeRefs: string[] = [];

  for (const pattern of TIME_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) {
      timeRefs.push(matches[0]);
    }
  }

  return timeRefs;
}

/**
 * Extract keywords for search.
 */
export function extractKeywords(text: string): string[] {
  // Remove common stop words and extract meaningful terms
  const stopWords = new Set([
    'the',
    'a',
    'an',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'being',
    'have',
    'has',
    'had',
    'do',
    'does',
    'did',
    'will',
    'would',
    'could',
    'should',
    'may',
    'might',
    'must',
    'shall',
    'can',
    'need',
    'dare',
    'ought',
    'used',
    'to',
    'of',
    'in',
    'for',
    'on',
    'with',
    'at',
    'by',
    'from',
    'as',
    'into',
    'through',
    'during',
    'before',
    'after',
    'above',
    'below',
    'between',
    'under',
    'again',
    'further',
    'then',
    'once',
    'here',
    'there',
    'when',
    'where',
    'why',
    'how',
    'all',
    'each',
    'few',
    'more',
    'most',
    'other',
    'some',
    'such',
    'no',
    'nor',
    'not',
    'only',
    'own',
    'same',
    'so',
    'than',
    'too',
    'very',
    'just',
    'and',
    'but',
    'if',
    'or',
    'because',
    'until',
    'while',
    'about',
    'against',
    'i',
    'me',
    'my',
    'myself',
    'we',
    'our',
    'ours',
    'ourselves',
    'you',
    'your',
    'yours',
    'yourself',
    'yourselves',
    'he',
    'him',
    'his',
    'himself',
    'she',
    'her',
    'hers',
    'herself',
    'it',
    'its',
    'itself',
    'they',
    'them',
    'their',
    'theirs',
    'themselves',
    'what',
    'which',
    'who',
    'whom',
    'this',
    'that',
    'these',
    'those',
    'am',
    'tell',
    'know',
    'remember',
    'anything',
    'something',
    'anyone',
    'someone',
  ]);

  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stopWords.has(word));

  return [...new Set(words)];
}

/**
 * Parse a question into structured components.
 */
export function parseQuestion(text: string): ParsedQuestion {
  return {
    original: text,
    type: detectQuestionType(text),
    entities: extractEntities(text),
    timeReferences: extractTimeReferences(text),
    keywords: extractKeywords(text),
  };
}
