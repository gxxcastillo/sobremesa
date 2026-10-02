import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlaceRepository } from './place-repository';

const mockSupabaseClient = {
  from: vi.fn(),
};

const createChainableMock = (finalResult: { data: any; error: any }) => {
  const chain: any = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.insert = vi.fn().mockReturnValue(chain);
  chain.update = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.ilike = vi.fn().mockReturnValue(chain);
  chain.in = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue(finalResult);
  chain.maybeSingle = vi.fn().mockResolvedValue(finalResult);
  chain.then = (resolve: (value: { data: unknown; error: unknown }) => void) =>
    resolve(finalResult);
  return chain;
};

describe('PlaceRepository - findByIds', () => {
  let placeRepo: PlaceRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    placeRepo = new PlaceRepository(mockSupabaseClient as any);
  });

  it('returns [] without querying when given no ids', async () => {
    const result = await placeRepo.findByIds('fam1', []);

    expect(result).toEqual([]);
    expect(mockSupabaseClient.from).not.toHaveBeenCalled();
  });

  it('queries places scoped to the family, excluding redacted ones', async () => {
    const rows = [{ id: 'place-1', family_id: 'fam1', name: 'Managua' }];
    const chain = createChainableMock({ data: rows, error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await placeRepo.findByIds('fam1', ['place-1', 'place-2']);

    expect(chain.eq).toHaveBeenCalledWith('family_id', 'fam1');
    expect(chain.eq).toHaveBeenCalledWith('redacted', false);
    expect(chain.in).toHaveBeenCalledWith('id', ['place-1', 'place-2']);
    expect(result).toHaveLength(1);
  });

  it('throws on a database error', async () => {
    const chain = createChainableMock({
      data: null,
      error: { message: 'boom' },
    });
    mockSupabaseClient.from.mockReturnValue(chain);

    await expect(placeRepo.findByIds('fam1', ['place-1'])).rejects.toThrow(
      'Failed to find places by id: boom',
    );
  });
});

describe('PlaceRepository - findByHierarchy', () => {
  let placeRepo: PlaceRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    placeRepo = new PlaceRepository(mockSupabaseClient as any);
  });

  it('returns null without querying when no country is given', async () => {
    const result = await placeRepo.findByHierarchy('fam1', { city: 'León' });

    expect(result).toBeNull();
    expect(mockSupabaseClient.from).not.toHaveBeenCalled();
  });

  it('matches city and country, scoped to the family', async () => {
    const row = {
      id: 'place-1',
      family_id: 'fam1',
      name: 'León',
      city: 'León',
      country: 'Nicaragua',
    };
    const chain = createChainableMock({ data: row, error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await placeRepo.findByHierarchy('fam1', {
      city: 'león',
      country: 'nicaragua',
    });

    expect(mockSupabaseClient.from).toHaveBeenCalledWith('places');
    expect(chain.eq).toHaveBeenCalledWith('family_id', 'fam1');
    expect(chain.eq).toHaveBeenCalledWith('redacted', false);
    expect(chain.ilike).toHaveBeenCalledWith('country', 'nicaragua');
    expect(chain.ilike).toHaveBeenCalledWith('city', 'león');
    expect(chain.eq).not.toHaveBeenCalledWith('type', 'country');
    expect(result).toMatchObject({ id: 'place-1', familyId: 'fam1' });
  });

  it('matches only country-level places when no city is given', async () => {
    const chain = createChainableMock({ data: null, error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await placeRepo.findByHierarchy('fam1', {
      country: 'Nicaragua',
    });

    expect(chain.eq).toHaveBeenCalledWith('type', 'country');
    expect(chain.ilike).not.toHaveBeenCalledWith('city', expect.anything());
    expect(result).toBeNull();
  });

  it('escapes LIKE wildcards so values match literally', async () => {
    const chain = createChainableMock({ data: null, error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    await placeRepo.findByHierarchy('fam1', {
      city: 'San_Jose',
      country: '100%',
    });

    expect(chain.ilike).toHaveBeenCalledWith('city', 'San\\_Jose');
    expect(chain.ilike).toHaveBeenCalledWith('country', '100\\%');
  });

  it('throws on a database error', async () => {
    const chain = createChainableMock({
      data: null,
      error: { message: 'boom' },
    });
    mockSupabaseClient.from.mockReturnValue(chain);

    await expect(
      placeRepo.findByHierarchy('fam1', { country: 'Nicaragua' }),
    ).rejects.toThrow('Failed to find place by hierarchy: boom');
  });
});
