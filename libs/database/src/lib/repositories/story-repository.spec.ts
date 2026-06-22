import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StoryRepository } from './story-repository';

const mockSupabaseClient = {
  from: vi.fn(),
};

const createChainableMock = (finalResult: { data: any; error: any }) => {
  const chain: any = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.insert = vi.fn().mockReturnValue(chain);
  chain.update = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.in = vi.fn().mockReturnValue(chain);
  chain.ilike = vi.fn().mockReturnValue(chain);
  chain.contains = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue(finalResult);
  chain.maybeSingle = vi.fn().mockResolvedValue(finalResult);
  chain.then = (resolve: (value: { data: unknown; error: unknown }) => void) =>
    resolve(finalResult);
  return chain;
};

const makeStoryRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'story-1',
  family_id: 'fam1',
  title: null,
  content_original: 'Maria remembered the long drive to Havana.',
  content_language: 'en',
  themes: ['travel'],
  timeframe: null,
  completeness: 'partial',
  confidence: 'medium',
  shared_by: null,
  redacted: false,
  extraction_version: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
});

describe('StoryRepository - findSimilar', () => {
  let storyRepo: StoryRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    storyRepo = new StoryRepository(mockSupabaseClient as any);
  });

  it('does NOT merge untitled stories on content and person alone (#3)', async () => {
    const story = makeStoryRow({
      content_original: 'Maria remembered the long drive to Havana.',
      themes: ['travel'],
    });

    const storyPeopleChain = createChainableMock({
      data: [{ story_id: 'story-1' }],
      error: null,
    });
    const storiesChain = createChainableMock({ data: [story], error: null });
    const overlapChain = createChainableMock({
      data: [{ story_id: 'story-1', person_id: 'person-1' }],
      error: null,
    });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return storyPeopleChain;
      if (callCount === 2) return storiesChain;
      return overlapChain;
    });

    const result = await storyRepo.findSimilar(
      'fam1',
      undefined,
      'Maria remembered the long drive to Havana.',
      ['person-1'],
      ['school'],
    );

    expect(result).toBeNull();
  });

  it('merges untitled stories when person, theme, and content corroborate (#3)', async () => {
    const story = makeStoryRow({
      content_original: 'Maria remembered the long drive to Havana.',
      themes: ['travel'],
    });

    const storyPeopleChain = createChainableMock({
      data: [{ story_id: 'story-1' }],
      error: null,
    });
    const storiesChain = createChainableMock({ data: [story], error: null });
    const overlapChain = createChainableMock({
      data: [{ story_id: 'story-1', person_id: 'person-1' }],
      error: null,
    });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return storyPeopleChain;
      if (callCount === 2) return storiesChain;
      return overlapChain;
    });

    const result = await storyRepo.findSimilar(
      'fam1',
      undefined,
      'Maria remembered the long drive to Havana.',
      ['person-1'],
      ['travel'],
    );

    expect(result?.id).toBe('story-1');
  });
});

describe('StoryRepository - appendToStory', () => {
  let storyRepo: StoryRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    storyRepo = new StoryRepository(mockSupabaseClient as any);
  });

  it('unions themes and carries timeframe when enriching an existing story (#7)', async () => {
    const existing = makeStoryRow({
      themes: ['travel'],
      timeframe: null,
      content_original: 'First fragment.',
    });
    const updated = makeStoryRow({
      themes: ['travel', 'school'],
      timeframe: '1960s',
      content_original: 'First fragment.\n\nSecond fragment.',
    });

    const findChain = createChainableMock({ data: existing, error: null });
    const updateChain = createChainableMock({ data: updated, error: null });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? findChain : updateChain;
    });

    const result = await storyRepo.appendToStory(
      'fam1',
      'story-1',
      'Second fragment.',
      'conv-2',
      ['school'],
      '1960s',
    );

    expect(updateChain.update).toHaveBeenCalledWith({
      content_original: 'First fragment.\n\nSecond fragment.',
      themes: ['travel', 'school'],
      timeframe: '1960s',
    });
    expect(result.themes).toEqual(['travel', 'school']);
    expect(result.timeframe).toBe('1960s');
  });

  it('does not overwrite an existing timeframe (#7)', async () => {
    const existing = makeStoryRow({
      themes: ['travel'],
      timeframe: '1950s',
      content_original: 'First fragment.',
    });
    const updated = makeStoryRow({
      themes: ['travel', 'school'],
      timeframe: '1950s',
      content_original: 'First fragment.\n\nSecond fragment.',
    });

    const findChain = createChainableMock({ data: existing, error: null });
    const updateChain = createChainableMock({ data: updated, error: null });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? findChain : updateChain;
    });

    await storyRepo.appendToStory(
      'fam1',
      'story-1',
      'Second fragment.',
      'conv-2',
      ['school'],
      '1960s',
    );

    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ timeframe: '1950s' }),
    );
  });
});
