#!/usr/bin/env npx tsx
/**
 * Test Scribe with full schema + inline pronoun resolution
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

const SCRIBE_PROMPT = `You are a family historian. Extract structured data from messages.

## Step 1: Understand the Message

Resolve all pronouns first:
- "I/me/my" → sender's name
- "he/she/they" → trace through context to actual person
- "it" in "I thought it was X" after "A is B" → sender thought X was B

## Step 2: Extract Structured Data

From the understood message, extract:

**people**: [{name, aliases[], birthYear?, deathYear?, confidence}]
**places**: [{name, type?, city?, region?, country?, confidence}]
**events**: [{title, eventType?, dateText?, dateYear?, peopleInvolved[], placeName?, confidence}]
**relationships**: [{personAName, personBName, relationshipType, confidence}]
**claims**: [{claimType, subject, claimValue, confidence, claimedBy, claimedBySource}]
**story**: {title?, content, themes[], timeframe?} (if narrative detected)

confidence: "high" | "medium" | "low"
claimedBySource: "direct" | "attributed" | "hearsay"

Output valid JSON only:
{"understood_message": "...", "people": [], "places": [], "events": [], "relationships": [], "claims": [], "story": null}`;

async function main() {
  const anthropic = new Anthropic();

  // Complex real-world test case
  const test = {
    sender: 'Grendel',
    context: [
      'Gabriel: I hope Ralph gets to join the chat',
      "Gabriel: Ralph is Marcus's oldest son",
      'Gabriel: He was born in San Jose in 1987',
    ],
    message:
      'I thought it was Mark? Mom always said he was the firstborn. I remember visiting them in California when I was little.',
  };

  console.log('Testing Scribe with FULL schema + pronoun resolution\n');
  console.log(`Message: "${test.message}"`);
  console.log(`Context: ${test.context.join(' | ')}\n`);

  const userPrompt = `SENDER: ${test.sender}

CONTEXT:
${test.context.map((c) => `- ${c}`).join('\n')}

MESSAGE:
"${test.message}"`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    system: SCRIBE_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content.find((c) => c.type === 'text');
  if (text?.type === 'text') {
    console.log('Raw response:');
    console.log(text.text);
    console.log('\n---');

    const jsonMatch = text.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        console.log('\nParsed successfully:');
        console.log(`Understood: "${parsed.understood_message}"`);
        console.log(`People: ${parsed.people?.length || 0}`);
        console.log(`Places: ${parsed.places?.length || 0}`);
        console.log(`Relationships: ${parsed.relationships?.length || 0}`);
        console.log(`Claims: ${parsed.claims?.length || 0}`);

        // Check key extractions
        const checks = [
          parsed.understood_message?.toLowerCase().includes('grendel'),
          parsed.understood_message?.toLowerCase().includes('mark was marcus'),
          parsed.claims?.some((c: { subject: string }) =>
            c.subject?.toLowerCase().includes('mark'),
          ),
        ];
        console.log(
          `\n${checks.every(Boolean) ? '✅ All checks pass' : '❌ Some checks failed'}`,
        );
      } catch (e) {
        console.log(`Parse error: ${e}`);
      }
    }
  }
}

main().catch(console.error);
