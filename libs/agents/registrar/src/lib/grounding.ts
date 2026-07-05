/**
 * Deterministic evidence grounding for claims (provenance plan #3).
 *
 * "Extract from the CURRENT MESSAGE only" is a prompt instruction; this module
 * is the check that doesn't trust the model. Every claim carries an `evidence`
 * span the LLM must quote verbatim from the current message. Verdicts:
 *
 * - `grounded`      — evidence appears in the current message; proceed.
 * - `context_bleed` — evidence appears only in a prior context message:
 *                     definite re-extraction of already-processed content.
 *                     The Registrar rejects the claim.
 * - `unmatched`     — evidence appears nowhere we can see (paraphrase or
 *                     hallucination). The claim is kept but flagged in the
 *                     claim analysis; measure before punishing.
 *
 * A message with no retrievable content can only ever yield `unmatched` —
 * without a current message to check against, bleed cannot be *proven*, and
 * rejection requires proof (spec agent-pipeline.md §3.4: flag, never reject).
 *
 * Shared by the Registrar (enforcement) and the eval harness (metric), so the
 * scored behavior is exactly the persisted behavior.
 */

import { wordTokens } from './name-match';

export type GroundingVerdict = 'grounded' | 'context_bleed' | 'unmatched';

/**
 * Normalize text for evidence containment: lowercase, diacritics folded,
 * punctuation/whitespace collapsed to single spaces. Reuses the `name-match`
 * tokenizer so grounding and entity matching normalize identically.
 */
export function normalizeForGrounding(text: string): string {
  return wordTokens(text, { foldDiacritics: true }).join(' ');
}

/**
 * Whole-word-anchored containment of an already-normalized span in an
 * already-normalized text ("ann" must not match inside "anna").
 */
function containsSpan(normalizedText: string, normalizedSpan: string): boolean {
  if (!normalizedSpan || !normalizedText) return false;
  return ` ${normalizedText} `.includes(` ${normalizedSpan} `);
}

export interface Grounder {
  ground(evidence: string | undefined): GroundingVerdict;
}

/**
 * Build a grounder with the current message and context normalized once, for
 * checking many claims against the same texts (the per-persist hot path).
 * A span present in BOTH current and context is `grounded` — the current
 * message legitimately restating context is not bleed. A missing or empty
 * span is `unmatched` (flag, never reject: absence of evidence is a contract
 * violation to measure, not proof of bleed).
 */
export function createGrounder(
  currentContent: string | undefined,
  contextContents: readonly string[] = [],
): Grounder {
  const current = currentContent ? normalizeForGrounding(currentContent) : '';
  // No current content → every verdict is 'unmatched'; skip normalizing
  // context we can never consult.
  const contexts = current ? contextContents.map(normalizeForGrounding) : [];

  return {
    ground(evidence) {
      if (!current) return 'unmatched';
      const span = evidence ? normalizeForGrounding(evidence) : '';
      if (!span) return 'unmatched';
      if (containsSpan(current, span)) return 'grounded';
      return contexts.some((context) => containsSpan(context, span))
        ? 'context_bleed'
        : 'unmatched';
    },
  };
}

/** One-shot convenience over `createGrounder` for single-claim callers. */
export function groundEvidence(
  evidence: string | undefined,
  currentContent: string | undefined,
  contextContents: readonly string[] = [],
): GroundingVerdict {
  return createGrounder(currentContent, contextContents).ground(evidence);
}
