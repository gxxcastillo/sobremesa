import { loadPrompt } from '@sobremesa/prompts';
import type {
  HistorianConfig,
  RetrievedContext,
  ParsedQuestion,
  ClaimWithSource,
} from './types';

/**
 * Build the system prompt with config values substituted.
 */
export function buildSystemPrompt(config: HistorianConfig): string {
  return loadPrompt('historian', {
    HISTORIAN_NAME: config.historianName,
    PRIMARY_LANGUAGE: config.primaryLanguage,
  });
}

/**
 * Build the user prompt with the question and retrieved context.
 */
export function buildUserPrompt(
  question: ParsedQuestion,
  context: RetrievedContext,
): string {
  const parts: string[] = [];

  // Build a lookup map from person IDs to names for relationship display
  const personNameById = new Map<string, string>();
  for (const { person } of context.people) {
    personNameById.set(person.id, person.name);
  }

  // Add the question
  parts.push('## QUESTION');
  parts.push(question.original);
  parts.push('');

  // Add people information
  if (context.people.length > 0) {
    parts.push('## PEOPLE IN FAMILY RECORDS');
    for (const { person, claims } of context.people) {
      parts.push(`### ${person.name}`);
      if (person.aliases && person.aliases.length > 0) {
        parts.push(`Also known as: ${person.aliases.join(', ')}`);
      }
      if (person.birthYear) {
        parts.push(`Birth year: ${person.birthYear}`);
      }
      if (person.deathYear) {
        parts.push(`Death year: ${person.deathYear}`);
      }
      // Note: Occupation and other facts come through claims with source attribution
      if (claims.length > 0) {
        parts.push('Claims about this person:');
        for (const claim of claims) {
          parts.push(`- ${formatClaim(claim)}`);
        }
      }
      parts.push('');
    }
  }

  // Add relationships
  if (context.relationships.length > 0) {
    parts.push('## FAMILY RELATIONSHIPS');
    for (const rel of context.relationships) {
      const personAName = personNameById.get(rel.personAId) || rel.personAId;
      const personBName = personNameById.get(rel.personBId) || rel.personBId;
      parts.push(
        `- ${personAName} is ${rel.relationshipType} of ${personBName}` +
          (rel.confidence ? ` (${rel.confidence} confidence)` : ''),
      );
    }
    parts.push('');
  }

  // Add timeline events
  if (context.events.length > 0) {
    parts.push('## TIMELINE EVENTS');
    for (const event of context.events) {
      let eventLine = `- **${event.title}**`;
      if (event.dateText || event.dateYear) {
        eventLine += ` (${event.dateText || event.dateYear})`;
      }
      if (event.place) {
        eventLine += ` at ${event.place}`;
      }
      if (event.peopleInvolved.length > 0) {
        eventLine += ` - involving: ${event.peopleInvolved.join(', ')}`;
      }
      parts.push(eventLine);
    }
    parts.push('');
  }

  // Add stories
  if (context.stories.length > 0) {
    parts.push('## FAMILY STORIES');
    for (const story of context.stories) {
      parts.push(`### ${story.title}`);
      if (story.timeframe) {
        parts.push(`Timeframe: ${story.timeframe}`);
      }
      if (story.themes.length > 0) {
        parts.push(`Themes: ${story.themes.join(', ')}`);
      }
      if (story.content) {
        // Truncate long stories
        const truncated =
          story.content.length > 500
            ? story.content.slice(0, 500) + '...'
            : story.content;
        parts.push(truncated);
      }
      parts.push('');
    }
  }

  // Add additional claims
  const standaloneClaims = context.claims.filter(
    (claim) =>
      !context.people.some((p) => p.claims.some((c) => c.id === claim.id)),
  );
  if (standaloneClaims.length > 0) {
    parts.push('## ADDITIONAL CLAIMS FROM FAMILY');
    for (const claim of standaloneClaims) {
      parts.push(`- ${formatClaim(claim)}`);
    }
    parts.push('');
  }

  // Add images if relevant
  if (context.images.length > 0) {
    parts.push('## RELEVANT PHOTOS');
    for (const image of context.images) {
      let imageLine = `- Photo`;
      if (image.estimatedEra) {
        imageLine += ` (~${image.estimatedEra})`;
      }
      if (image.description) {
        imageLine += `: ${image.description}`;
      }
      if (image.peopleIdentified.length > 0) {
        imageLine += ` - Identified: ${image.peopleIdentified.join(', ')}`;
      }
      parts.push(imageLine);
    }
    parts.push('');
  }

  // Note conflicts
  if (context.hasConflicts) {
    parts.push('## NOTE: CONFLICTING INFORMATION');
    parts.push(
      'The following subjects have different accounts from different family members:',
    );
    for (const [subject, claims] of context.conflicts.entries()) {
      parts.push(`- **${subject}**:`);
      for (const claim of claims) {
        parts.push(`  - ${formatClaim(claim)}`);
      }
    }
    parts.push(
      'Present BOTH versions without resolving - both memories are valuable.',
    );
    parts.push('');
  }

  // Note if no information found
  if (
    context.people.length === 0 &&
    context.events.length === 0 &&
    context.stories.length === 0 &&
    context.claims.length === 0
  ) {
    parts.push('## NO INFORMATION FOUND');
    parts.push(
      "The family records don't have information about this topic yet.",
    );
    parts.push('');

    // Be specific about what was searched for
    if (question.entities.length > 0) {
      parts.push(
        `Entities searched: ${question.entities.join(
          ', ',
        )} - no matches found in family records.`,
      );
    }
    if (question.keywords.length > 0) {
      parts.push(
        `Keywords searched: ${question.keywords.join(
          ', ',
        )} - no relevant records found.`,
      );
    }
    parts.push('');

    parts.push('IMPORTANT INSTRUCTIONS FOR THIS RESPONSE:');
    parts.push(
      "1. Be transparent: Clearly state that you don't have information about the specific people/topics mentioned in the question.",
    );
    parts.push(
      '2. Echo the question: Reference what was actually asked (e.g., "I don\'t have any records about Michael or his marriage...").',
    );
    parts.push(
      '3. Stay relevant: Any follow-up question MUST directly relate to the original question. Do NOT ask about unrelated topics like dates, summers, or locations that were not mentioned.',
    );
    parts.push(
      '4. Invite specific contributions: Ask if anyone in the family knows about the specific person or topic asked about.',
    );
    parts.push(
      '5. NEVER invent context: Do not imply you know anything you don\'t (e.g., don\'t ask "which summer?" if no summer was mentioned).',
    );
    parts.push('');
  }

  // Final instruction
  parts.push('---');
  parts.push(
    'Please answer the question using ONLY the information provided above. ' +
      'Be warm and conversational. Cite sources naturally. ' +
      'If there are conflicts, present both versions without resolving.',
  );

  return parts.join('\n');
}

/**
 * Format a claim for display in the prompt.
 */
function formatClaim(claim: ClaimWithSource): string {
  let text = '';

  // Source attribution
  switch (claim.claimedBySource) {
    case 'direct':
      text += `${claim.claimedBy} shared that `;
      break;
    case 'attributed':
      text += `According to ${claim.claimedBy}, `;
      break;
    case 'hearsay':
      text += `The family recalls that `;
      break;
  }

  // Claim content
  text += `${claim.subject}: ${formatClaimValue(claim.claimValue)}`;

  // Confidence indicator
  if (claim.confidence === 'low') {
    text += ' (uncertain)';
  } else if (claim.confidence === 'high') {
    text += ' (confident)';
  }

  // Certainty language if provided
  if (claim.certaintyLanguage) {
    text += ` - they said "${claim.certaintyLanguage}"`;
  }

  return text;
}

/**
 * Format a claim value for display.
 */
function formatClaimValue(value: unknown): string {
  if (value === null || value === undefined) {
    return 'unknown';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'object') {
    // Handle common claim value structures
    const obj = value as Record<string, unknown>;
    if ('year' in obj) {
      return String(obj.year);
    }
    if ('date' in obj) {
      return String(obj.date);
    }
    if ('name' in obj) {
      return String(obj.name);
    }
    // Default to JSON for complex objects
    return JSON.stringify(value);
  }
  return String(value);
}
