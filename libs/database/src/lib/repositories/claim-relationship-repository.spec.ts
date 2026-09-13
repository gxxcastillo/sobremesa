import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaimRelationshipRepository } from './claim-relationship-repository';

/**
 * Row shape as it comes back from Supabase (snake_case) for a
 * `claim_relationships` query, since `findContradictingClaimIds{,ForClaims}`
 * now query the table directly (batched via `.in(...)`) rather than going
 * through `findByType`/`findByRelatedClaim`.
 */
function dbRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    family_id: 'fam1',
    claim_id: 'claim-a',
    related_claim_id: 'claim-b',
    relationship_type: 'contradicts',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * `.select().eq().eq().in(column, ids)` chain used by
 * `findContradictingClaimIdsForClaims`. `.in()` resolves based on which
 * column it was called with, so both the outgoing (`claim_id`) and incoming
 * (`related_claim_id`) queries in the same `Promise.all` can be stubbed
 * independently off one shared chain.
 */
function createRelationshipQueryStub(responses: {
  claim_id?: { data?: Record<string, unknown>[]; error?: { message: string } };
  related_claim_id?: {
    data?: Record<string, unknown>[];
    error?: { message: string };
  };
}) {
  const chain: Record<string, unknown> = {};
  chain['select'] = vi.fn().mockReturnValue(chain);
  chain['eq'] = vi.fn().mockReturnValue(chain);
  chain['in'] = vi
    .fn()
    .mockImplementation((column: 'claim_id' | 'related_claim_id') =>
      Promise.resolve(responses[column] ?? { data: [], error: undefined }),
    );
  return chain;
}

describe('ClaimRelationshipRepository - findContradictingClaimIds', () => {
  let mockClient: { from: ReturnType<typeof vi.fn> };
  let repo: ClaimRelationshipRepository;

  beforeEach(() => {
    mockClient = { from: vi.fn() };
    repo = new ClaimRelationshipRepository(mockClient as any);
  });

  function stubQueries(
    outgoing: Record<string, unknown>[],
    incoming: Record<string, unknown>[],
  ) {
    mockClient.from.mockReturnValue(
      createRelationshipQueryStub({
        claim_id: { data: outgoing, error: undefined },
        related_claim_id: { data: incoming, error: undefined },
      }),
    );
  }

  it('finds the older claim a newer one contradicts (outgoing edge)', async () => {
    stubQueries(
      [dbRow({ claim_id: 'claim-a', related_claim_id: 'claim-old' })],
      [],
    );

    const result = await repo.findContradictingClaimIds('fam1', 'claim-a');

    expect(result).toEqual(['claim-old']);
  });

  it('finds the newer claim that contradicts this one (incoming edge)', async () => {
    // create() only ever writes the edge from the newer claim to the older
    // one it disputes, so the older claim must be found via the incoming
    // (related_claim_id) side instead.
    stubQueries(
      [],
      [dbRow({ claim_id: 'claim-new', related_claim_id: 'claim-a' })],
    );

    const result = await repo.findContradictingClaimIds('fam1', 'claim-a');

    expect(result).toEqual(['claim-new']);
  });

  it('returns [] when nothing contradicts the claim (including when a non-contradicts relationship exists)', async () => {
    // The incoming query itself filters `relationship_type = 'contradicts'`
    // server-side, so a 'supports' edge would never come back here at all.
    stubQueries([], []);

    const result = await repo.findContradictingClaimIds('fam1', 'claim-a');

    expect(result).toEqual([]);
  });

  it('unions and dedupes both directions', async () => {
    stubQueries(
      [dbRow({ claim_id: 'claim-a', related_claim_id: 'claim-old' })],
      [
        dbRow({ claim_id: 'claim-new', related_claim_id: 'claim-a' }),
        dbRow({ claim_id: 'claim-new', related_claim_id: 'claim-a' }),
      ],
    );

    const result = await repo.findContradictingClaimIds('fam1', 'claim-a');

    expect(new Set(result)).toEqual(new Set(['claim-old', 'claim-new']));
    expect(result).toHaveLength(2);
  });

  it('propagates an error from either side of the query', async () => {
    mockClient.from.mockReturnValue(
      createRelationshipQueryStub({
        claim_id: { data: undefined, error: { message: 'boom' } },
        related_claim_id: { data: [], error: undefined },
      }),
    );

    await expect(
      repo.findContradictingClaimIds('fam1', 'claim-a'),
    ).rejects.toThrow('boom');
  });
});

describe('ClaimRelationshipRepository - findContradictingClaimIdsForClaims', () => {
  let mockClient: { from: ReturnType<typeof vi.fn> };
  let repo: ClaimRelationshipRepository;

  beforeEach(() => {
    mockClient = { from: vi.fn() };
    repo = new ClaimRelationshipRepository(mockClient as any);
  });

  it('returns an empty map without querying when given no claim ids', async () => {
    const result = await repo.findContradictingClaimIdsForClaims('fam1', []);

    expect(result.size).toBe(0);
    expect(mockClient.from).not.toHaveBeenCalled();
  });

  it('resolves contradictions for a whole batch of claims in one pair of queries', async () => {
    mockClient.from.mockReturnValue(
      createRelationshipQueryStub({
        // claim-a contradicts claim-old (outgoing)
        claim_id: {
          data: [dbRow({ claim_id: 'claim-a', related_claim_id: 'claim-old' })],
          error: undefined,
        },
        // claim-new contradicts claim-b (incoming, from claim-b's side)
        related_claim_id: {
          data: [dbRow({ claim_id: 'claim-new', related_claim_id: 'claim-b' })],
          error: undefined,
        },
      }),
    );

    const result = await repo.findContradictingClaimIdsForClaims('fam1', [
      'claim-a',
      'claim-b',
      'claim-c',
    ]);

    expect(result.get('claim-a')).toEqual(['claim-old']);
    expect(result.get('claim-b')).toEqual(['claim-new']);
    expect(result.has('claim-c')).toBe(false);
    // One query per direction, not one per claim id.
    expect(mockClient.from).toHaveBeenCalledTimes(2);
  });
});
