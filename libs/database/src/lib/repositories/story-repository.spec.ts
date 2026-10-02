import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StoryRepository } from './story-repository';

const mockSupabaseClient = {
  from: vi.fn(),
  rpc: vi.fn(),
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
  chain.limit = vi.fn().mockReturnValue(chain);
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

describe('StoryRepository - findOrCreate (F: one contribution per message)', () => {
  let storyRepo: StoryRepository;

  const extracted = {
    title: 'The drive to Havana',
    content: 'Maria remembered the long drive to Havana.',
    themes: ['travel'],
    timeframe: '1950s',
  };

  // from() calls in order: the contribution lookup, then findSimilar's
  // candidate fetch (no person ids -> findAllActive).
  const mockReads = (linkRows: unknown[], candidateRows: unknown[]) => {
    const linkChain = createChainableMock({ data: linkRows, error: null });
    const candidatesChain = createChainableMock({
      data: candidateRows,
      error: null,
    });
    mockSupabaseClient.from.mockImplementation((table: string) =>
      table === 'story_conversation_events' ? linkChain : candidatesChain,
    );
    return { linkChain, candidatesChain };
  };

  const mockRpc = (result: { data: unknown; error: unknown }) => {
    const single = vi.fn().mockResolvedValue(result);
    mockSupabaseClient.rpc.mockReturnValue({ single });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    storyRepo = new StoryRepository(mockSupabaseClient as any);
  });

  it('writes nothing and skips similarity matching when the message already contributed', async () => {
    const { linkChain } = mockReads([{ story_id: 'story-1' }], []);

    const result = await storyRepo.findOrCreate(
      'fam1',
      extracted,
      [],
      'conv-1',
      'en',
    );

    expect(result).toEqual({ storyId: 'story-1', outcome: 'already_applied' });
    expect(linkChain.eq).toHaveBeenCalledWith('family_id', 'fam1');
    expect(linkChain.eq).toHaveBeenCalledWith(
      'conversation_event_id',
      'conv-1',
    );
    expect(mockSupabaseClient.from).toHaveBeenCalledTimes(1);
    expect(mockSupabaseClient.rpc).not.toHaveBeenCalled();
  });

  it('creates through the atomic function when no similar story exists', async () => {
    mockReads([], []);
    mockRpc({
      data: { story_id: 'story-new', outcome: 'created' },
      error: null,
    });

    const result = await storyRepo.findOrCreate(
      'fam1',
      extracted,
      [],
      'conv-1',
      'en',
      'Abuela',
      'registrar-v1',
    );

    expect(result).toEqual({ storyId: 'story-new', outcome: 'created' });
    expect(mockSupabaseClient.rpc).toHaveBeenCalledWith(
      'persist_story_contribution',
      {
        p_family_id: 'fam1',
        p_conversation_event_id: 'conv-1',
        p_target_story_id: null,
        p_title: 'The drive to Havana',
        p_content: 'Maria remembered the long drive to Havana.',
        p_content_language: 'en',
        p_themes: ['travel'],
        p_timeframe: '1950s',
        p_shared_by: 'Abuela',
        p_extraction_version: 'registrar-v1',
      },
    );
  });

  it('targets the matched story when a similar one exists', async () => {
    mockReads(
      [],
      [
        makeStoryRow({
          id: 'story-1',
          title: 'The drive to Havana',
          content_original: 'Maria remembered the long drive to Havana.',
          themes: ['travel'],
        }),
      ],
    );
    mockRpc({
      data: { story_id: 'story-1', outcome: 'appended' },
      error: null,
    });

    const result = await storyRepo.findOrCreate(
      'fam1',
      extracted,
      [],
      'conv-2',
      'en',
    );

    expect(result).toEqual({ storyId: 'story-1', outcome: 'appended' });
    expect(mockSupabaseClient.rpc).toHaveBeenCalledWith(
      'persist_story_contribution',
      expect.objectContaining({
        p_target_story_id: 'story-1',
        p_conversation_event_id: 'conv-2',
      }),
    );
  });

  it('fails loud when the function errors, so the queue retries', async () => {
    mockReads([], []);
    mockRpc({ data: null, error: { message: 'boom' } });

    await expect(
      storyRepo.findOrCreate('fam1', extracted, [], 'conv-1', 'en'),
    ).rejects.toThrow('Failed to persist story contribution: boom');
  });

  it('fails loud when the contribution lookup errors', async () => {
    const linkChain = createChainableMock({
      data: null,
      error: { message: 'down' },
    });
    mockSupabaseClient.from.mockReturnValue(linkChain);

    await expect(
      storyRepo.findOrCreate('fam1', extracted, [], 'conv-1', 'en'),
    ).rejects.toThrow('Failed to look up story contribution: down');
    expect(mockSupabaseClient.rpc).not.toHaveBeenCalled();
  });
});
