import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EntityMatcherService } from './entity-matcher';
import type { ExtractedPerson } from '@sobremesa/shared-types';

const mockPersonRepo = {
  findBestMatch: vi.fn(),
  findPlaceholderByNormalizedName: vi.fn(),
};

const mockPlaceRepo = {};

function extractedPerson(name: string): ExtractedPerson {
  return { name, aliases: [], confidence: 'high' } as ExtractedPerson;
}

describe('EntityMatcherService - matchPerson placeholder reuse (F3)', () => {
  let matcher: EntityMatcherService;

  beforeEach(() => {
    vi.clearAllMocks();
    matcher = new EntityMatcherService(
      mockPersonRepo as any,
      mockPlaceRepo as any,
    );
  });

  it('reuses an existing placeholder for a relational description that exactly matches', async () => {
    mockPersonRepo.findBestMatch.mockResolvedValue(null);
    mockPersonRepo.findPlaceholderByNormalizedName.mockResolvedValue({
      id: 'placeholder-1',
      name: "Ricardo Hermoso's father",
      aliases: [],
    });

    const result = await matcher.matchPerson(
      'fam1',
      extractedPerson("Ricardo Hermoso's father"),
    );

    expect(result.matched).toBe(true);
    expect(result.existingEntityId).toBe('placeholder-1');
    expect(result.confidence).toBe(1.0);
    expect(result.matchReason).toBe('placeholder reuse: exact normalized name');
    expect(mockPersonRepo.findPlaceholderByNormalizedName).toHaveBeenCalledWith(
      'fam1',
      "Ricardo Hermoso's father",
    );
  });

  it('never reaches placeholder lookup when a real person already matched', async () => {
    mockPersonRepo.findBestMatch.mockResolvedValue({
      person: { id: 'real-1', name: 'Ricardo Hermoso', aliases: [] },
      confidence: 'high',
      matchReason: 'exact match',
    });

    const result = await matcher.matchPerson(
      'fam1',
      extractedPerson('Ricardo Hermoso'),
    );

    expect(result.existingEntityId).toBe('real-1');
    expect(
      mockPersonRepo.findPlaceholderByNormalizedName,
    ).not.toHaveBeenCalled();
  });

  it('does not attempt placeholder reuse for a generic (non-relational) name', async () => {
    mockPersonRepo.findBestMatch.mockResolvedValue(null);

    const result = await matcher.matchPerson(
      'fam1',
      extractedPerson('the neighbor'),
    );

    expect(result.matched).toBe(false);
    expect(
      mockPersonRepo.findPlaceholderByNormalizedName,
    ).not.toHaveBeenCalled();
  });

  it('does not attempt placeholder reuse for an ordinary real name with no match', async () => {
    mockPersonRepo.findBestMatch.mockResolvedValue(null);

    const result = await matcher.matchPerson(
      'fam1',
      extractedPerson('Robert Williams'),
    );

    expect(result.matched).toBe(false);
    expect(
      mockPersonRepo.findPlaceholderByNormalizedName,
    ).not.toHaveBeenCalled();
  });

  it('creates a new placeholder when no existing placeholder matches', async () => {
    mockPersonRepo.findBestMatch.mockResolvedValue(null);
    mockPersonRepo.findPlaceholderByNormalizedName.mockResolvedValue(null);

    const result = await matcher.matchPerson(
      'fam1',
      extractedPerson("Maria's son"),
    );

    expect(result.matched).toBe(false);
    expect(result.matchReason).toBe('no_match');
  });

  it('leaves suggestedAliases unset on a placeholder-reuse match', async () => {
    mockPersonRepo.findBestMatch.mockResolvedValue(null);
    mockPersonRepo.findPlaceholderByNormalizedName.mockResolvedValue({
      id: 'placeholder-1',
      name: "Ricardo Hermoso's father",
      aliases: [],
    });

    const result = await matcher.matchPerson(
      'fam1',
      extractedPerson("Ricardo Hermoso's father"),
    );

    expect(result.suggestedAliases).toBeUndefined();
  });

  it('does not reuse a placeholder when its biographical data conflicts', async () => {
    mockPersonRepo.findBestMatch.mockResolvedValue(null);
    mockPersonRepo.findPlaceholderByNormalizedName.mockResolvedValue({
      id: 'placeholder-1',
      name: "Ricardo Hermoso's father",
      aliases: [],
      birthYear: 1900,
    });

    const result = await matcher.matchPerson('fam1', {
      ...extractedPerson("Ricardo Hermoso's father"),
      birthYear: 2000,
    });

    expect(result).toMatchObject({
      matched: false,
      matchReason: 'biographical_conflict_creating_new',
    });
  });
});
