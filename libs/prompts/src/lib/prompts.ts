import adminPrompt from '../agents/admin.md?raw';
import curatorPrompt from '../agents/curator.md?raw';
import facilitatorPrompt from '../agents/facilitator.md?raw';
import historianPrompt from '../agents/historian.md?raw';
import internFilterPrompt from '../agents/intern-filter.md?raw';
import internImageLinkPrompt from '../agents/intern-image-link.md?raw';
import scribePrompt from '../agents/scribe.md?raw';

export type PromptName = keyof typeof prompts;

const prompts = {
  admin: adminPrompt,
  curator: curatorPrompt,
  facilitator: facilitatorPrompt,
  historian: historianPrompt,
  internFilter: internFilterPrompt,
  internImageLink: internImageLinkPrompt,
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
