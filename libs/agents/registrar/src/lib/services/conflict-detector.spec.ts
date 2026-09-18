import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictDetectorService } from './conflict-detector';
import type { ExtractedClaim } from '@sobremesa/shared-types';
import type { Claim } from '@sobremesa/shared-types';

const mockClaimRepo = {
  findActiveBySubject: vi.fn(),
  findByEntity: vi.fn(),
};

function existingClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: 'existing-1',
    familyId: 'fam1',
    subject: 'Luciana Rose Castillo',
    claimType: 'relationship',
    claimValue: { relationshipType: 'sibling', to: 'her brothers' },
    conversationEventId: 'event-1',
    claimedBy: 'Someone',
    claimedBySource: 'direct',
    claimedAt: new Date(),
    confidence: 'medium',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as Claim;
}

function newClaim(overrides: Partial<ExtractedClaim> = {}): ExtractedClaim {
  return {
    claimType: 'relationship',
    subject: 'Luciana Rose Castillo',
    claimValue: {
      relationshipType: 'great-grandchild',
      to: 'our grandparents',
    },
    confidence: 'medium',
    claimedBySource: 'direct',
    referencedPeople: [],
    referencedPlaces: [],
    ...overrides,
  } as ExtractedClaim;
}

describe('ConflictDetectorService.detectConflicts — relationship counterparty (#5d)', () => {
  let service: ConflictDetectorService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ConflictDetectorService(mockClaimRepo as any);
  });

  it('does not flag different-counterparty relationship claims as conflicting (real corpus case)', async () => {
    mockClaimRepo.findActiveBySubject.mockResolvedValue([existingClaim()]);

    const conflicts = await service.detectConflicts('fam1', newClaim());

    expect(conflicts).toEqual([]);
  });

  it('flags a genuine same-counterparty relationship-type contradiction', async () => {
    mockClaimRepo.findActiveBySubject.mockResolvedValue([
      existingClaim({
        claimValue: { relationshipType: 'parent', relative: 'Enrique Najlis' },
      }),
    ]);

    const conflicts = await service.detectConflicts(
      'fam1',
      newClaim({
        claimValue: { relationshipType: 'sibling', relative: 'Enrique Najlis' },
      }),
    );

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      hasConflict: true,
      conflictingClaimId: 'existing-1',
      conflictType: 'contradicts',
    });
  });

  it('does not flag a citation-only text difference as a conflict', async () => {
    mockClaimRepo.findActiveBySubject.mockResolvedValue([
      existingClaim({
        subject: "Michel Vega's heart attack",
        claimType: 'date',
        claimValue: { year: 2018, text: 'at age 43' },
      }),
    ]);

    const conflicts = await service.detectConflicts(
      'fam1',
      newClaim({
        subject: "Michel Vega's heart attack",
        claimType: 'date',
        claimValue: { year: 2018, text: '8 years ago' },
      }),
    );

    expect(conflicts).toEqual([]);
  });
});
