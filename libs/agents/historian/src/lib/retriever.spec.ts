import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataRetriever } from './retriever';
import { DEFAULT_HISTORIAN_CONFIG } from './types';
import type { ParsedQuestion, HistorianConfig } from './types';
import type { Person, Claim, ClaimAnalysis } from '@sobremesa/shared-types';

function makePerson(overrides: Partial<Person> = {}): Person {
  return {
    id: 'person-1',
    familyId: 'fam1',
    name: 'Rosa',
    aliases: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: 'claim-1',
    familyId: 'fam1',
    claimType: 'date',
    subject: 'Birth year',
    claimValue: { year: 1891 },
    conversationEventId: 'event-1',
    claimedBy: 'Rosa',
    claimedBySource: 'direct',
    claimedAt: new Date('2026-01-01T00:00:00Z'),
    confidence: 'medium',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeAnalysis(claimId: string, claimStrength: number): ClaimAnalysis {
  return {
    id: `analysis-${claimId}`,
    familyId: 'fam1',
    claimId,
    claimStrength,
    createdAt: new Date(),
  };
}

function makeConfig(overrides: Partial<HistorianConfig> = {}): HistorianConfig {
  return { ...DEFAULT_HISTORIAN_CONFIG, ...overrides };
}

function makeQuestion(overrides: Partial<ParsedQuestion> = {}): ParsedQuestion {
  return {
    original: 'Tell me about Rosa',
    type: 'person_info',
    entities: ['Rosa'],
    timeReferences: [],
    keywords: [],
    ...overrides,
  };
}

describe('DataRetriever', () => {
  let personRepo: {
    findByFuzzyMatch: ReturnType<typeof vi.fn>;
    findAllActive: ReturnType<typeof vi.fn>;
  };
  let claimRepo: {
    findByEntity: ReturnType<typeof vi.fn>;
    findAllActive: ReturnType<typeof vi.fn>;
    findByIds: ReturnType<typeof vi.fn>;
  };
  let claimRelationshipRepo: {
    findContradictingClaimIds: ReturnType<typeof vi.fn>;
  };
  let claimAnalysisRepo: { findByClaimIds: ReturnType<typeof vi.fn> };
  let relationshipRepo: {
    findByPerson: ReturnType<typeof vi.fn>;
    findBetween: ReturnType<typeof vi.fn>;
  };
  let eventRepo: {
    findByPerson: ReturnType<typeof vi.fn>;
    findByTimeRange: ReturnType<typeof vi.fn>;
    findAllActive: ReturnType<typeof vi.fn>;
  };
  let storyRepo: {
    findAllActive: ReturnType<typeof vi.fn>;
    findByPerson: ReturnType<typeof vi.fn>;
  };
  let placeRepo: { findAllActive: ReturnType<typeof vi.fn> };
  let imageRepo: { findByPerson: ReturnType<typeof vi.fn> };
  let retriever: DataRetriever;

  beforeEach(() => {
    personRepo = {
      findByFuzzyMatch: vi.fn().mockResolvedValue(null),
      findAllActive: vi.fn().mockResolvedValue([]),
    };
    claimRepo = {
      findByEntity: vi.fn().mockResolvedValue([]),
      findAllActive: vi.fn().mockResolvedValue([]),
      findByIds: vi.fn().mockResolvedValue([]),
    };
    claimRelationshipRepo = {
      findContradictingClaimIds: vi.fn().mockResolvedValue([]),
    };
    claimAnalysisRepo = { findByClaimIds: vi.fn().mockResolvedValue([]) };
    relationshipRepo = {
      findByPerson: vi.fn().mockResolvedValue([]),
      findBetween: vi.fn().mockResolvedValue(null),
    };
    eventRepo = {
      findByPerson: vi.fn().mockResolvedValue([]),
      findByTimeRange: vi.fn().mockResolvedValue([]),
      findAllActive: vi.fn().mockResolvedValue([]),
    };
    storyRepo = {
      findAllActive: vi.fn().mockResolvedValue([]),
      findByPerson: vi.fn().mockResolvedValue([]),
    };
    placeRepo = { findAllActive: vi.fn().mockResolvedValue([]) };
    imageRepo = { findByPerson: vi.fn().mockResolvedValue([]) };

    retriever = new DataRetriever({
      personRepo: personRepo as any,
      claimRepo: claimRepo as any,
      claimRelationshipRepo: claimRelationshipRepo as any,
      claimAnalysisRepo: claimAnalysisRepo as any,
      relationshipRepo: relationshipRepo as any,
      eventRepo: eventRepo as any,
      storyRepo: storyRepo as any,
      placeRepo: placeRepo as any,
      imageRepo: imageRepo as any,
    });
  });

  describe('persisted conflicts (agent-hygiene-plan.md #5b)', () => {
    it('surfaces a conflict recorded via claim_relationships even when the contradicting claim was not in the original retrieval batch', async () => {
      const claimA = makeClaim({ id: 'claim-a', subject: 'Birth year' });
      personRepo.findByFuzzyMatch.mockResolvedValue(makePerson());
      claimRepo.findByEntity.mockResolvedValue([claimA]);
      // The partner claim (recorded months apart) was never fetched by this
      // query's own strategy.
      claimRelationshipRepo.findContradictingClaimIds.mockImplementation(
        async (_familyId: string, claimId: string) =>
          claimId === 'claim-a' ? ['claim-b'] : [],
      );
      const claimB = makeClaim({
        id: 'claim-b',
        subject: 'Birth year',
        claimValue: { year: 1893 },
      });
      claimRepo.findByIds.mockResolvedValue([claimB]);

      const context = await retriever.retrieve(
        'fam1',
        makeQuestion(),
        makeConfig(),
      );

      expect(context.hasConflicts).toBe(true);
      expect(claimRepo.findByIds).toHaveBeenCalledWith('fam1', ['claim-b']);
      const group = context.conflicts.get('Birth year');
      expect(group?.map((c) => c.id).sort()).toEqual(['claim-a', 'claim-b']);
    });

    it('does not flag same-value claims that differ only in representation when no link is persisted', async () => {
      // "1891" vs 1891 across two retrieved claims about the same subject —
      // the old value-inequality detector would have flagged this.
      const claimA = makeClaim({
        id: 'claim-a',
        subject: 'Birth year',
        claimValue: { year: '1891' },
      });
      const claimB = makeClaim({
        id: 'claim-b',
        subject: 'Birth year',
        claimValue: { year: 1891 },
      });
      personRepo.findByFuzzyMatch.mockResolvedValue(makePerson());
      claimRepo.findByEntity.mockResolvedValue([claimA, claimB]);
      claimRelationshipRepo.findContradictingClaimIds.mockResolvedValue([]);

      const context = await retriever.retrieve(
        'fam1',
        makeQuestion(),
        makeConfig(),
      );

      expect(context.hasConflicts).toBe(false);
      expect(context.conflicts.size).toBe(0);
    });

    it('does not report a conflict when nothing was retrieved', async () => {
      const context = await retriever.retrieve(
        'fam1',
        makeQuestion({ entities: [] }),
        makeConfig(),
      );

      expect(context.hasConflicts).toBe(false);
      expect(
        claimRelationshipRepo.findContradictingClaimIds,
      ).not.toHaveBeenCalled();
    });
  });

  describe('claim ordering before truncation (agent-hygiene-plan.md #5c)', () => {
    it('keeps the highest-strength claim over a more recent, weaker one when the cap is smaller than the retrieved set', async () => {
      const strongOld = makeClaim({
        id: 'strong-old',
        claimedAt: new Date('2020-01-01T00:00:00Z'),
      });
      const weakNew = makeClaim({
        id: 'weak-new',
        claimedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const midRecent = makeClaim({
        id: 'mid-recent',
        claimedAt: new Date('2025-01-01T00:00:00Z'),
      });
      // Repository order is claimed_at DESC, as the real repositories return.
      personRepo.findByFuzzyMatch.mockResolvedValue(makePerson());
      claimRepo.findByEntity.mockResolvedValue([weakNew, midRecent, strongOld]);
      claimAnalysisRepo.findByClaimIds.mockResolvedValue([
        makeAnalysis('strong-old', 0.9),
        makeAnalysis('weak-new', 0.1),
        makeAnalysis('mid-recent', 0.5),
      ]);

      const context = await retriever.retrieve(
        'fam1',
        makeQuestion(),
        makeConfig({ maxClaimsPerQuery: 2 }),
      );

      const ids = context.people[0]?.claims.map((c) => c.id);
      expect(ids).toEqual(['strong-old', 'mid-recent']);
    });

    it('falls back to recency when strength is equal or unknown', async () => {
      const older = makeClaim({
        id: 'older',
        claimedAt: new Date('2020-01-01T00:00:00Z'),
      });
      const newer = makeClaim({
        id: 'newer',
        claimedAt: new Date('2026-01-01T00:00:00Z'),
      });
      personRepo.findByFuzzyMatch.mockResolvedValue(makePerson());
      claimRepo.findByEntity.mockResolvedValue([newer, older]);
      claimAnalysisRepo.findByClaimIds.mockResolvedValue([]);

      const context = await retriever.retrieve(
        'fam1',
        makeQuestion(),
        makeConfig({ maxClaimsPerQuery: 2 }),
      );

      const ids = context.people[0]?.claims.map((c) => c.id);
      expect(ids).toEqual(['newer', 'older']);
    });
  });
});
