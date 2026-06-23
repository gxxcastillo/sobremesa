/**
 * Test script for mention detection in InternAgent.
 * Run with: bun scripts/test-mention-detection.ts
 */

// Test the isBotMentioned regex logic directly
// This mirrors the logic in InternAgent.isBotMentioned()
function isBotMentioned(messageText: string, botUsername: string): boolean {
  // Negative lookbehind (?<![a-zA-Z0-9]) ensures @ isn't preceded by alphanumeric
  // This prevents matching email-like patterns (email@bot.com)
  const mentionPattern = new RegExp(`(?<![a-zA-Z0-9])@${botUsername}\\b`, 'i');
  return mentionPattern.test(messageText);
}

const BOT_USERNAME = 'SobremesaBot';

const testCases = [
  // Should match
  { text: '@SobremesaBot hello!', expected: true, desc: 'mention at start' },
  {
    text: 'Hey @SobremesaBot can you help?',
    expected: true,
    desc: 'mention in middle',
  },
  { text: 'Thanks @SobremesaBot', expected: true, desc: 'mention at end' },
  { text: '@sobremesabot lowercase', expected: true, desc: 'case insensitive' },
  { text: '@SOBREMESABOT uppercase', expected: true, desc: 'all caps' },
  { text: '@SobremesaBot', expected: true, desc: 'just the mention' },

  // Should match with punctuation
  { text: '(@SobremesaBot)', expected: true, desc: 'mention in parens' },
  {
    text: 'Hey, @SobremesaBot!',
    expected: true,
    desc: 'mention with comma before',
  },
  { text: '"@SobremesaBot"', expected: true, desc: 'mention in quotes' },

  // Should NOT match
  { text: 'Hello everyone!', expected: false, desc: 'no mention' },
  { text: '@OtherBot hello', expected: false, desc: 'different bot' },
  {
    text: 'email@SobremesaBot.com',
    expected: false,
    desc: 'email-like (no space before @)',
  },
  {
    text: 'user123@SobremesaBot',
    expected: false,
    desc: 'alphanumeric before @',
  },
  { text: 'SobremesaBot without @', expected: false, desc: 'name without @' },
  {
    text: '@SobremesaBotExtra',
    expected: false,
    desc: 'username with extra chars (word boundary)',
  },
  { text: '', expected: false, desc: 'empty string' },
];

console.log('Testing mention detection...\n');
console.log(`Bot username: ${BOT_USERNAME}\n`);

let passed = 0;
let failed = 0;

for (const tc of testCases) {
  const result = isBotMentioned(tc.text, BOT_USERNAME);
  const status = result === tc.expected ? '✓' : '✗';

  if (result === tc.expected) {
    passed++;
    console.log(`${status} ${tc.desc}`);
    console.log(`  Input: "${tc.text}"`);
    console.log(`  Expected: ${tc.expected}, Got: ${result}\n`);
  } else {
    failed++;
    console.log(`${status} FAILED: ${tc.desc}`);
    console.log(`  Input: "${tc.text}"`);
    console.log(`  Expected: ${tc.expected}, Got: ${result}\n`);
  }
}

console.log('---');
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
