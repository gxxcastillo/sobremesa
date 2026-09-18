import * as z from 'zod';
import type { JsonSchema } from '@sobremesa/ai-provider';

/**
 * The formulation call's response shape (prompt v3.1,
 * story-followups-plan.md #0). `when` existed through v3 but was dropped:
 * every follow-up now waits for quiet instead of the model choosing timing
 * (plan decision D2).
 */
export const FollowupFormulationSchema = z.object({
  ask: z.boolean(),
  question: z.string(),
  /** Every person, place or event the question names. The grounding guard
   * in `followup.ts` checks each one appears in what the model was shown. */
  names_used: z.array(z.string()),
  story_context: z.string(),
  reason: z.string(),
});

export type RawFollowupFormulation = z.infer<typeof FollowupFormulationSchema>;

export const FOLLOWUP_JSON_SCHEMA: JsonSchema = {
  name: 'question_formulation',
  schema: FollowupFormulationSchema.toJSONSchema() as Record<string, unknown>,
};
