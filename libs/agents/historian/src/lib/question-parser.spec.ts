import { describe, it, expect } from 'vitest';
import { isQuestion, parseQuestion } from './question-parser';

describe('isQuestion', () => {
  it.each([
    ['Who was grandpa Abraham?', true],
    ['When did the family come to America?', true],
    ['Where did grandma grow up?', true],
    ['What happened at the 1962 wedding?', true],
    ['How is Maria related to Roberto?', true],
    ['Is it true that grandpa was a baker?', true],
    ['Tell me about the grocery store story', true],
    ['Do you know anything about Uncle David?', true],
    ['Does anyone remember when we moved to Chicago?', true],
    ["What's the story about the old house?", true],
    ['Can you tell me about great aunt Rosa?', true],
    ['I want to know about the family recipes', true],
    ['Who?', true],
    ['Really?', true],
    ['I wonder who that was in the photo', true],
    ['Grandpa Abraham was a wonderful man.', false],
    ['The family came to America in 1952.', false],
    ['I remember grandma used to make the best cookies.', false],
    ['Maria and Roberto were cousins.', false],
    ['Here is a photo from the 1962 wedding.', false],
    ['Thanks for sharing that story!', false],
    ['That reminds me of something...', false],
    ['Hello everyone!', false],
    ['lol that was so funny', false],
    ['The question is whether we should go.', false],
  ])('%s -> %s', (input, expected) => {
    expect(isQuestion(input)).toBe(expected);
  });
});

describe('parseQuestion - type detection', () => {
  it.each([
    ['Who was grandpa Abraham?', 'person_info'],
    ['When did the family come to America?', 'timeline'],
    ['Where did grandma grow up?', 'location'],
    ['What happened at the 1962 wedding?', 'event'],
    ['How is Maria related to Roberto?', 'relationship'],
    ['Is it true that grandpa was a baker?', 'verification'],
    ['Tell me about the grocery store story', 'story'],
    ['Do you know anything about Uncle David?', 'person_info'],
    ['Does anyone remember when we moved to Chicago?', 'timeline'],
    ["What's the story about the old house?", 'story'],
    ['Can you tell me about great aunt Rosa?', 'person_info'],
    ['I want to know about the family recipes', 'general'],
    ['Who?', 'general'],
    ['Really?', 'general'],
    ['I wonder who that was in the photo', 'general'],
  ])('%s -> %s', (input, expectedType) => {
    expect(parseQuestion(input).type).toBe(expectedType);
  });
});

describe('parseQuestion - entity extraction', () => {
  it('finds a name after a family term', () => {
    expect(parseQuestion('Who was Abraham Garcia?').entities).toContain(
      'Abraham',
    );
  });

  it('finds multiple names joined by "and"', () => {
    const { entities } = parseQuestion(
      'Tell me about Uncle David and Aunt Maria',
    );
    expect(entities).toEqual(
      expect.arrayContaining(['Uncle', 'David', 'Aunt', 'Maria']),
    );
  });

  it('finds a place name', () => {
    expect(
      parseQuestion('What happened in Chicago in 1952?').entities,
    ).toContain('Chicago');
  });

  it('finds a full name split across matches', () => {
    const { entities } = parseQuestion(
      'How is Rosa related to Roberto Hernandez?',
    );
    expect(entities).toEqual(
      expect.arrayContaining(['Rosa', 'Roberto', 'Hernandez']),
    );
  });
});

describe('parseQuestion - time reference extraction', () => {
  it('finds a bare year', () => {
    expect(parseQuestion('What happened in 1952?').timeReferences).toContain(
      '1952',
    );
  });

  it('finds a decade', () => {
    expect(parseQuestion('Tell me about the 1960s').timeReferences).toContain(
      '1960s',
    );
  });

  it('finds a decade with an "early/mid/late" qualifier', () => {
    const { timeReferences } = parseQuestion(
      'When did grandpa arrive in the early 1900s?',
    );
    expect(timeReferences).toEqual(
      expect.arrayContaining(['1900s', 'early 1900s']),
    );
  });

  it('does not recognize spelled-out decades like "fifties"', () => {
    expect(
      parseQuestion('What was life like in the fifties?').timeReferences,
    ).toEqual([]);
  });
});
