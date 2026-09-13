import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaimRelationshipRepository } from './claim-relationship-repository';
import type { ClaimRelationship } from '@sobremesa/shared-types';

const mockSupabaseClient = {
  from: vi.fn(),
};

describe('ClaimRelationshipRepository - findContradictingClaimIds', () => {
  let repo: ClaimRelationshipRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = new ClaimRelationshipRepository(mockSupabaseClient as any);
  });

  const relationship = (
    overrides: Partial<ClaimRelationship>,
  ): ClaimRelationship => ({
    familyId: 'fam1',
    claimId: 'claim-a',
    relatedClaimId: 'claim-b',
    relationshipType: 'contradicts',
    createdAt: new Date(),
    ...overrides,
  });

  it('finds the older claim a newer one contradicts (outgoing edge)', async () => {
    vi.spyOn(repo, 'findByType').mockResolvedValue([
      relationship({ claimId: 'claim-a', relatedClaimId: 'claim-old' }),
    ]);
    vi.spyOn(repo, 'findByRelatedClaim').mockResolvedValue([]);

    const result = await repo.findContradictingClaimIds('fam1', 'claim-a');

    expect(result).toEqual(['claim-old']);
  });

  it('finds the newer claim that contradicts this one (incoming edge)', async () => {
    // create() only ever writes the edge from the newer claim to the older
    // one it disputes, so the older claim must be found via the incoming
    // (related_claim_id) side instead.
    vi.spyOn(repo, 'findByType').mockResolvedValue([]);
    vi.spyOn(repo, 'findByRelatedClaim').mockResolvedValue([
      relationship({ claimId: 'claim-new', relatedClaimId: 'claim-a' }),
    ]);

    const result = await repo.findContradictingClaimIds('fam1', 'claim-a');

    expect(result).toEqual(['claim-new']);
  });

  it('ignores incoming relationships that are not contradictions', async () => {
    vi.spyOn(repo, 'findByType').mockResolvedValue([]);
    vi.spyOn(repo, 'findByRelatedClaim').mockResolvedValue([
      relationship({
        claimId: 'claim-new',
        relatedClaimId: 'claim-a',
        relationshipType: 'supports',
      }),
    ]);

    const result = await repo.findContradictingClaimIds('fam1', 'claim-a');

    expect(result).toEqual([]);
  });

  it('unions and dedupes both directions', async () => {
    vi.spyOn(repo, 'findByType').mockResolvedValue([
      relationship({ claimId: 'claim-a', relatedClaimId: 'claim-old' }),
    ]);
    vi.spyOn(repo, 'findByRelatedClaim').mockResolvedValue([
      relationship({ claimId: 'claim-new', relatedClaimId: 'claim-a' }),
      relationship({ claimId: 'claim-new', relatedClaimId: 'claim-a' }),
    ]);

    const result = await repo.findContradictingClaimIds('fam1', 'claim-a');

    expect(new Set(result)).toEqual(new Set(['claim-old', 'claim-new']));
    expect(result).toHaveLength(2);
  });

  it('returns [] when nothing contradicts the claim', async () => {
    vi.spyOn(repo, 'findByType').mockResolvedValue([]);
    vi.spyOn(repo, 'findByRelatedClaim').mockResolvedValue([]);

    const result = await repo.findContradictingClaimIds('fam1', 'claim-a');

    expect(result).toEqual([]);
  });
});
