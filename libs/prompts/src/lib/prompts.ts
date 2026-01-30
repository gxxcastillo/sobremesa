import adminPrompt from '../agents/admin.txt?raw';
import curatorPrompt from '../agents/curator.txt?raw';
import facilitatorPrompt from '../agents/facilitator.txt?raw';
import facilitatorResponsePrompt from '../agents/facilitator-response.txt?raw';
import historianPrompt from '../agents/historian.txt?raw';
import internFilterPrompt from '../agents/intern-filter.txt?raw';
import internImageLinkPrompt from '../agents/intern-image-link.txt?raw';
import internPronounsPrompt from '../agents/intern-pronouns.txt?raw';
import scribePrompt from '../agents/scribe.txt?raw';

export type PromptName = keyof typeof prompts;

const prompts = {
  admin: adminPrompt,
  curator: curatorPrompt,
  facilitator: facilitatorPrompt,
  facilitatorResponse: facilitatorResponsePrompt,
  historian: historianPrompt,
  internFilter: internFilterPrompt,
  internImageLink: internImageLinkPrompt,
  internPronouns: internPronounsPrompt,
  scribe: scribePrompt,
} as const;

export function loadPrompt(
  promptName: PromptName,
  values: Record<string, string> = {},
): string {
  return fillPromptTemplate(prompts[promptName], values);
}

/**
 * Replace placeholders in a prompt template with actual values.
 * Placeholders are in the format {PLACEHOLDER_NAME}.
 *
 * @param template - The prompt template string
 * @param values - Object mapping placeholder names to their values
 * @returns The template with placeholders replaced
 */
export function fillPromptTemplate(
  template: string,
  values: Record<string, string>,
): string {
  let result = template;

  for (const [key, value] of Object.entries(values)) {
    const placeholder = `{${key}}`;
    result = result.replace(
      new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'),
      value,
    );
  }

  return result;
}
