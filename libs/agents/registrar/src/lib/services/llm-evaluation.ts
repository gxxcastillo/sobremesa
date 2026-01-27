import type { Claim } from '@sobremesa/shared-types';

/**
 * Request for LLM claim evaluation.
 */
export interface LlmClaimEvaluationRequest {
  claim: Claim;
  sourceContext: {
    conversationText: string;
    speaker: string;
    timestamp: Date;
  };
  conflicts?: {
    claim: Claim;
    conflictType: 'contradicts' | 'refines' | 'supports';
  }[];
}

/**
 * Result of LLM claim evaluation.
 */
export interface LlmClaimEvaluationResult {
  score: number; // 0.0-1.0
  reasoning: string;
  recommendations?: {
    suggestSupersede?: string[]; // Claim IDs to supersede
    suggestDispute?: boolean;
    suggestMerge?: {
      targetClaimId: string;
      mergeReasoning: string;
    };
  };
}

/**
 * Request for LLM entity matching verification.
 */
export interface LlmEntityMatchRequest {
  extractedEntity: {
    name: string;
    aliases?: string[];
    birthYear?: number;
    deathYear?: number;
  };
  candidateEntity: {
    id: string;
    name: string;
    aliases: string[];
    birthYear?: number;
    deathYear?: number;
  };
  context: {
    conversationText: string;
    relatedPeople?: string[];
    relatedPlaces?: string[];
  };
}

/**
 * Result of LLM entity matching.
 */
export interface LlmEntityMatchResult {
  isSameEntity: boolean;
  confidence: number; // 0.0-1.0
  reasoning: string;
}

/**
 * Prompt templates for LLM evaluation.
 */
export const LlmPrompts = {
  /**
   * Evaluate claim reliability.
   */
  evaluateClaim: (request: LlmClaimEvaluationRequest): string => {
    const conflictsSection = request.conflicts?.length
      ? `
## Conflicting Claims

${request.conflicts
  .map(
    (c, i) =>
      `${i + 1}. "${c.claim.subject}": ${JSON.stringify(c.claim.claimValue)}
   - Source: ${c.claim.claimedBySource}
   - Certainty: "${c.claim.certaintyLanguage || 'not specified'}"
   - Current strength: ${c.claim.claimStrength?.toFixed(2) || 'not calculated'}
   - Conflict type: ${c.conflictType}`,
  )
  .join('\n\n')}
`
      : '';

    return `You are evaluating a claim from a family history conversation for reliability and accuracy.

## Claim to Evaluate

**Subject**: "${request.claim.subject}"
**Type**: ${request.claim.claimType}
**Value**: ${JSON.stringify(request.claim.claimValue, null, 2)}
**Source**: ${request.claim.claimedBySource} (${request.claim.claimedBy})
**Certainty language**: "${request.claim.certaintyLanguage || 'not specified'}"
**Date**: ${request.claim.claimedAt.toISOString()}

## Source Context

${request.sourceContext.conversationText}

**Speaker**: ${request.sourceContext.speaker}
**Timestamp**: ${request.sourceContext.timestamp.toISOString()}
${conflictsSection}

## Your Task

Rate this claim's reliability on a scale of 0.0 to 1.0, where:
- 1.0 = Completely reliable (direct knowledge, high certainty, no conflicts)
- 0.7-0.9 = Reliable (attributed source, reasonable certainty, minor conflicts)
- 0.5-0.7 = Moderately reliable (some uncertainty or conflicts)
- 0.3-0.5 = Low reliability (hearsay, high uncertainty, major conflicts)
- 0.0-0.3 = Very unreliable (contradictory, vague, or implausible)

Consider:
1. Source reliability (direct vs attributed vs hearsay)
2. Certainty language ("definitely" vs "I think" vs "might")
3. Internal consistency (does this make sense given other information?)
4. Specificity (precise dates/names vs vague references)
5. Conflicts with other claims

Respond in JSON format:
{
  "score": 0.85,
  "reasoning": "Detailed explanation of your rating...",
  "recommendations": {
    "suggestSupersede": ["claim-id-1"], // Optional: claims this should supersede
    "suggestDispute": false, // Optional: mark as disputed
    "suggestMerge": { // Optional: merge with another claim
      "targetClaimId": "claim-id-2",
      "mergeReasoning": "These claims are the same fact stated differently"
    }
  }
}`;
  },

  /**
   * Verify entity match.
   */
  verifyEntityMatch: (request: LlmEntityMatchRequest): string => {
    return `You are helping resolve whether two person references refer to the same individual in a family history context.

## Extracted Person (from new conversation)

**Name**: ${request.extractedEntity.name}
**Aliases**: ${request.extractedEntity.aliases?.join(', ') || 'none'}
**Birth Year**: ${request.extractedEntity.birthYear || 'unknown'}
**Death Year**: ${request.extractedEntity.deathYear || 'unknown'}

## Candidate Match (existing in database)

**Name**: ${request.candidateEntity.name}
**Aliases**: ${request.candidateEntity.aliases.join(', ')}
**Birth Year**: ${request.candidateEntity.birthYear || 'unknown'}
**Death Year**: ${request.candidateEntity.deathYear || 'unknown'}

## Context from Conversation

${request.context.conversationText}

${
  request.context.relatedPeople?.length
    ? `**Related people mentioned**: ${request.context.relatedPeople.join(', ')}`
    : ''
}
${
  request.context.relatedPlaces?.length
    ? `**Related places mentioned**: ${request.context.relatedPlaces.join(', ')}`
    : ''
}

## Your Task

Determine if these two person references are the same individual.

Consider:
1. Name similarity (accounting for nicknames, maiden names, etc.)
2. Biographical consistency (birth/death years must not conflict)
3. Context clues (relationships, locations, time periods)
4. Common naming patterns in the family/culture

Respond in JSON format:
{
  "isSameEntity": true,
  "confidence": 0.85,
  "reasoning": "Detailed explanation of your determination..."
}`;
  },

  /**
   * Resolve complex conflict.
   */
  resolveConflict: (claims: Claim[]): string => {
    return `You are helping resolve a conflict between multiple claims in a family history database.

## Conflicting Claims

${claims
  .map(
    (c, i) => `### Claim ${i + 1}
**Subject**: "${c.subject}"
**Value**: ${JSON.stringify(c.claimValue, null, 2)}
**Source**: ${c.claimedBySource} (${c.claimedBy})
**Certainty**: "${c.certaintyLanguage || 'not specified'}"
**Current strength**: ${c.claimStrength?.toFixed(2) || 'not calculated'}
**Date created**: ${c.createdAt?.toISOString()}
`,
  )
  .join('\n')}

## Your Task

Analyze these conflicting claims and determine which is most likely to be correct, or if they can be reconciled.

Consider:
1. Source reliability (who made each claim?)
2. Temporal proximity (was the claim made closer to the event?)
3. Specificity (more specific claims may be more reliable)
4. Consistency with other known facts
5. Possibility of errors (typos, misremembering, etc.)

Respond in JSON format:
{
  "winningClaimId": "claim-id-here",
  "reasoning": "Detailed explanation of why this claim is most reliable...",
  "supersededClaimIds": ["claim-id-1", "claim-id-2"],
  "confidence": 0.85,
  "notes": "Additional context or caveats..."
}`;
  },
};

/**
 * Blend algorithmic and LLM scores.
 *
 * @param algorithmScore - Initial algorithmic score (0.0-1.0)
 * @param llmScore - LLM evaluation score (0.0-1.0)
 * @returns Blended final score (0.0-1.0)
 */
export function blendScores(algorithmScore: number, llmScore: number): number {
  // Weight: 40% algorithm, 60% LLM
  // This gives more weight to LLM's contextual understanding
  // while still respecting the algorithmic baseline
  return algorithmScore * 0.4 + llmScore * 0.6;
}
