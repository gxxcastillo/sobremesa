import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImageRepository } from './image-repository';

// Mock Supabase client
const mockSupabaseClient = {
  from: vi.fn(),
};

// Helper to create chainable mock
const createChainableMock = (finalResult: { data: any; error: any }) => {
  const chain: any = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.insert = vi.fn().mockReturnValue(chain);
  chain.update = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.contains = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue(finalResult);
  // For operations that don't call single()
  chain.then = (resolve: (value: { data: unknown; error: unknown }) => void) =>
    resolve(finalResult);
  return chain;
};

describe('ImageRepository - addConnectedPeople', () => {
  let imageRepo: ImageRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    imageRepo = new ImageRepository(mockSupabaseClient as any);
  });

  it('should merge new person IDs with existing ones', async () => {
    // Mock findById to return existing image with some connected people
    const existingImage = {
      id: 'img-123',
      family_id: 'family-abc',
      connected_people: ['person-1', 'person-2'],
      connected_stories: [],
      visible_text: [],
      analyzed: true,
      redacted: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const updatedImage = {
      ...existingImage,
      connected_people: ['person-1', 'person-2', 'person-3', 'person-4'],
    };

    // First call: findById
    const findChain = createChainableMock({ data: existingImage, error: null });
    // Second call: update
    const updateChain = createChainableMock({
      data: updatedImage,
      error: null,
    });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? findChain : updateChain;
    });

    await imageRepo.addConnectedPeople('family-abc', 'img-123', [
      'person-3',
      'person-4',
    ]);

    // Verify update was called with merged array
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        connected_people: expect.arrayContaining([
          'person-1',
          'person-2',
          'person-3',
          'person-4',
        ]),
      }),
    );
  });

  it('should deduplicate person IDs', async () => {
    const existingImage = {
      id: 'img-123',
      family_id: 'family-abc',
      connected_people: ['person-1', 'person-2'],
      connected_stories: [],
      visible_text: [],
      analyzed: true,
      redacted: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const updatedImage = {
      ...existingImage,
      connected_people: ['person-1', 'person-2', 'person-3'],
    };

    const findChain = createChainableMock({ data: existingImage, error: null });
    const updateChain = createChainableMock({
      data: updatedImage,
      error: null,
    });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? findChain : updateChain;
    });

    await imageRepo.addConnectedPeople(
      'family-abc',
      'img-123',
      ['person-2', 'person-3'], // person-2 already exists
    );

    // Verify update was called with deduplicated array (person-2 not duplicated)
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        connected_people: expect.arrayContaining([
          'person-1',
          'person-2',
          'person-3',
        ]),
      }),
    );

    // Verify the array length is 3, not 4
    const updateCall = updateChain.update.mock.calls[0][0];
    expect(updateCall.connected_people.length).toBe(3);
  });

  it('should throw error if image not found', async () => {
    const findChain = createChainableMock({
      data: null,
      error: { code: 'PGRST116', message: 'Not found' },
    });

    mockSupabaseClient.from.mockReturnValue(findChain);

    await expect(
      imageRepo.addConnectedPeople('family-abc', 'nonexistent', ['person-1']),
    ).rejects.toThrow('Image not found: nonexistent');
  });

  it('should handle empty existing connected_people', async () => {
    const existingImage = {
      id: 'img-123',
      family_id: 'family-abc',
      connected_people: [],
      connected_stories: [],
      visible_text: [],
      analyzed: false,
      redacted: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const updatedImage = {
      ...existingImage,
      connected_people: ['person-1', 'person-2'],
    };

    const findChain = createChainableMock({ data: existingImage, error: null });
    const updateChain = createChainableMock({
      data: updatedImage,
      error: null,
    });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? findChain : updateChain;
    });

    await imageRepo.addConnectedPeople('family-abc', 'img-123', [
      'person-1',
      'person-2',
    ]);

    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        connected_people: ['person-1', 'person-2'],
      }),
    );
  });
});

describe('ImageRepository - addContext', () => {
  let imageRepo: ImageRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    imageRepo = new ImageRepository(mockSupabaseClient as any);
  });

  it('should append context to existing analysis', async () => {
    const existingImage = {
      id: 'img-123',
      family_id: 'family-abc',
      analysis: {
        description: 'AI analysis of the image',
        userContexts: [{ text: 'Previous context', sourceEventId: 'event-1' }],
      },
      connected_people: [],
      connected_stories: [],
      visible_text: [],
      analyzed: true,
      redacted: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const updatedImage = {
      ...existingImage,
      analysis: {
        description: 'AI analysis of the image',
        userContexts: [
          { text: 'Previous context', sourceEventId: 'event-1' },
          { text: 'New context about the photo', sourceEventId: 'event-2' },
        ],
      },
    };

    const findChain = createChainableMock({ data: existingImage, error: null });
    const updateChain = createChainableMock({
      data: updatedImage,
      error: null,
    });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? findChain : updateChain;
    });

    await imageRepo.addContext(
      'family-abc',
      'img-123',
      'New context about the photo',
      'event-2',
    );

    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        analysis: {
          description: 'AI analysis of the image',
          userContexts: [
            { text: 'Previous context', sourceEventId: 'event-1' },
            { text: 'New context about the photo', sourceEventId: 'event-2' },
          ],
        },
      }),
    );
  });

  it('should create userContexts array if not exists', async () => {
    const existingImage = {
      id: 'img-123',
      family_id: 'family-abc',
      analysis: { description: 'AI analysis' },
      connected_people: [],
      connected_stories: [],
      visible_text: [],
      analyzed: true,
      redacted: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const updatedImage = {
      ...existingImage,
      analysis: {
        description: 'AI analysis',
        userContexts: [{ text: 'First context', sourceEventId: 'event-1' }],
      },
    };

    const findChain = createChainableMock({ data: existingImage, error: null });
    const updateChain = createChainableMock({
      data: updatedImage,
      error: null,
    });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? findChain : updateChain;
    });

    await imageRepo.addContext(
      'family-abc',
      'img-123',
      'First context',
      'event-1',
    );

    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        analysis: {
          description: 'AI analysis',
          userContexts: [{ text: 'First context', sourceEventId: 'event-1' }],
        },
      }),
    );
  });

  it('should create analysis object if null', async () => {
    const existingImage = {
      id: 'img-123',
      family_id: 'family-abc',
      analysis: null,
      connected_people: [],
      connected_stories: [],
      visible_text: [],
      analyzed: false,
      redacted: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const updatedImage = {
      ...existingImage,
      analysis: {
        userContexts: [
          { text: 'Context for unanalyzed image', sourceEventId: 'event-1' },
        ],
      },
    };

    const findChain = createChainableMock({ data: existingImage, error: null });
    const updateChain = createChainableMock({
      data: updatedImage,
      error: null,
    });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? findChain : updateChain;
    });

    await imageRepo.addContext(
      'family-abc',
      'img-123',
      'Context for unanalyzed image',
      'event-1',
    );

    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        analysis: {
          userContexts: [
            { text: 'Context for unanalyzed image', sourceEventId: 'event-1' },
          ],
        },
      }),
    );
  });

  it('should throw error if image not found', async () => {
    const findChain = createChainableMock({
      data: null,
      error: { code: 'PGRST116', message: 'Not found' },
    });

    mockSupabaseClient.from.mockReturnValue(findChain);

    await expect(
      imageRepo.addContext('family-abc', 'nonexistent', 'context', 'event-1'),
    ).rejects.toThrow('Image not found: nonexistent');
  });

  it('should include sourceEventId for provenance tracking', async () => {
    const existingImage = {
      id: 'img-123',
      family_id: 'family-abc',
      analysis: {},
      connected_people: [],
      connected_stories: [],
      visible_text: [],
      analyzed: false,
      redacted: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const findChain = createChainableMock({ data: existingImage, error: null });
    const updateChain = createChainableMock({
      data: existingImage,
      error: null,
    });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? findChain : updateChain;
    });

    await imageRepo.addContext(
      'family-abc',
      'img-123',
      'Wedding photo from 1962',
      'source-event-xyz',
    );

    const updateCall = updateChain.update.mock.calls[0][0];
    expect(updateCall.analysis.userContexts[0]).toEqual({
      text: 'Wedding photo from 1962',
      sourceEventId: 'source-event-xyz',
    });
  });
});
