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
