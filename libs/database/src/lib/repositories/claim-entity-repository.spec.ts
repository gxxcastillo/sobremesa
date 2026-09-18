import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaimEntityRepository } from './claim-entity-repository';

const mockSupabaseClient = {
  from: vi.fn(),
};

const createChainableMock = (finalResult: { data: any; error: any }) => {
  const chain: any = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.insert = vi.fn().mockReturnValue(chain);
  chain.update = vi.fn().mockReturnValue(chain);
  chain.delete = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.in = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue(finalResult);
  chain.then = (resolve: (value: { data: unknown; error: unknown }) => void) =>
    resolve(finalResult);
  return chain;
};

describe('ClaimEntityRepository - findByClaims', () => {
  let claimEntityRepo: ClaimEntityRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    claimEntityRepo = new ClaimEntityRepository(mockSupabaseClient as any);
  });

  it('returns [] without querying when given no claim ids', async () => {
    const result = await claimEntityRepo.findByClaims('fam1', []);

    expect(result).toEqual([]);
    expect(mockSupabaseClient.from).not.toHaveBeenCalled();
  });

  it('queries claim_entities scoped to the family for every claim id, ordered by id', async () => {
    const rows = [
      {
        id: 'ce-1',
        family_id: 'fam1',
        claim_id: 'claim-1',
        entity_id: 'person-1',
        entity_type: 'person',
      },
    ];
    const chain = createChainableMock({ data: rows, error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await claimEntityRepo.findByClaims('fam1', [
      'claim-1',
      'claim-2',
    ]);

    expect(chain.eq).toHaveBeenCalledWith('family_id', 'fam1');
    expect(chain.in).toHaveBeenCalledWith('claim_id', ['claim-1', 'claim-2']);
    expect(chain.order).toHaveBeenCalledWith('id', { ascending: true });
    expect(result).toHaveLength(1);
    expect(result[0].entityType).toBe('person');
  });

  it('throws on a database error', async () => {
    const chain = createChainableMock({
      data: null,
      error: { message: 'boom' },
    });
    mockSupabaseClient.from.mockReturnValue(chain);

    await expect(
      claimEntityRepo.findByClaims('fam1', ['claim-1']),
    ).rejects.toThrow('Failed to find claim entities: boom');
  });
});
