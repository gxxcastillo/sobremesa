import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaimRepository } from './claim-repository';

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
  chain.neq = vi.fn().mockReturnValue(chain);
  chain.ilike = vi.fn().mockReturnValue(chain);
  chain.in = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue(finalResult);
  // For operations that don't call single()
  chain.then = (resolve: (value: { data: unknown; error: unknown }) => void) =>
    resolve(finalResult);
  return chain;
};

describe('ClaimRepository - detectConflict', () => {
  let claimRepo: ClaimRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    claimRepo = new ClaimRepository(mockSupabaseClient as any);
  });

  describe('basic conflict detection', () => {
    it('should detect conflict when values differ', () => {
      const existing = { year: 1990 };
      const newValue = { year: 1985 };

      expect(claimRepo.detectConflict(existing, newValue)).toBe(true);
    });

    it('should NOT detect conflict when values are the same', () => {
      const existing = { year: 1990 };
      const newValue = { year: 1990 };

      expect(claimRepo.detectConflict(existing, newValue)).toBe(false);
    });

    it('should NOT detect conflict for non-overlapping keys', () => {
      const existing = { birthYear: 1990 };
      const newValue = { deathYear: 2020 };

      expect(claimRepo.detectConflict(existing, newValue)).toBe(false);
    });
  });

  describe('numeric tolerance (±2 years)', () => {
    it('should NOT detect conflict for years within 2 year tolerance', () => {
      // 1990 vs 1991 = 1 year difference, should NOT conflict
      expect(claimRepo.detectConflict({ year: 1990 }, { year: 1991 })).toBe(
        false,
      );

      // 1990 vs 1992 = 2 year difference, should NOT conflict
      expect(claimRepo.detectConflict({ year: 1990 }, { year: 1992 })).toBe(
        false,
      );

      // 1990 vs 1988 = 2 year difference, should NOT conflict
      expect(claimRepo.detectConflict({ year: 1990 }, { year: 1988 })).toBe(
        false,
      );
    });

    it('should detect conflict for years more than 2 years apart', () => {
      // 1990 vs 1993 = 3 year difference, should conflict
      expect(claimRepo.detectConflict({ year: 1990 }, { year: 1993 })).toBe(
        true,
      );

      // 1990 vs 1987 = 3 year difference, should conflict
      expect(claimRepo.detectConflict({ year: 1990 }, { year: 1987 })).toBe(
        true,
      );

      // 1950 vs 1960 = 10 year difference, should conflict
      expect(claimRepo.detectConflict({ year: 1950 }, { year: 1960 })).toBe(
        true,
      );
    });
  });

  describe('string comparisons', () => {
    it('should detect conflict for different string values', () => {
      const existing = { name: 'John' };
      const newValue = { name: 'Jane' };

      expect(claimRepo.detectConflict(existing, newValue)).toBe(true);
    });

    it('should NOT detect conflict for same string values', () => {
      const existing = { name: 'John' };
      const newValue = { name: 'John' };

      expect(claimRepo.detectConflict(existing, newValue)).toBe(false);
    });
  });

  describe('null/undefined handling', () => {
    it('should NOT detect conflict when existing value is null', () => {
      const existing = { year: null };
      const newValue = { year: 1990 };

      expect(claimRepo.detectConflict(existing, newValue)).toBe(false);
    });

    it('should NOT detect conflict when new value is null', () => {
      const existing = { year: 1990 };
      const newValue = { year: null };

      expect(claimRepo.detectConflict(existing, newValue)).toBe(false);
    });

    it('should NOT detect conflict when existing value is undefined', () => {
      const existing = { year: undefined };
      const newValue = { year: 1990 };

      expect(claimRepo.detectConflict(existing, newValue)).toBe(false);
    });
  });

  describe('complex claim values', () => {
    it('should detect conflict in date claims with different years', () => {
      const existing = {
        year: 1992,
        month: 3,
        day: 15,
        text: 'March 15, 1992',
      };
      const newValue = {
        year: 1995,
        month: 3,
        day: 15,
        text: 'March 15, 1995',
      };

      expect(claimRepo.detectConflict(existing, newValue)).toBe(true);
    });

    it('should NOT detect conflict in date claims with same year, different text', () => {
      // Text differences don't matter if the data is the same
      const existing = {
        year: 1992,
        month: 3,
        day: 15,
        text: 'March 15, 1992',
      };
      const newValue = { year: 1992, month: 3, day: 15, text: '3/15/92' };

      // This will conflict on 'text' since strings are compared strictly
      expect(claimRepo.detectConflict(existing, newValue)).toBe(true);
    });

    it('should NOT detect conflict when new claim adds more detail', () => {
      const existing = { year: 1992 };
      const newValue = { year: 1992, month: 3, day: 15 };

      expect(claimRepo.detectConflict(existing, newValue)).toBe(false);
    });
  });
});

describe('ClaimRepository - createFromExtracted', () => {
  let claimRepo: ClaimRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    claimRepo = new ClaimRepository(mockSupabaseClient as any);
  });

  describe('JSON parsing of claim values', () => {
    it('should parse JSON string claim values', async () => {
      const insertedClaim = {
        id: 'claim-1',
        family_id: 'fam1',
        claim_type: 'birth_date',
        subject: 'John',
        claim_value: { year: 1992, month: 3, day: 13 },
        conversation_event_id: 'event-1',
        claimed_by: 'user-1',
        claimed_at: new Date().toISOString(),
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const chain = createChainableMock({ data: insertedClaim, error: null });
      mockSupabaseClient.from.mockReturnValue(chain);

      await claimRepo.createFromExtracted(
        'fam1',
        {
          claimType: 'birth_date',
          subject: 'John',
          claimValue: '{"year": 1992, "month": 3, "day": 13}',
          confidence: 'high' as const,
        },
        'event-1',
        'user-1',
      );

      expect(chain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          claim_value: { year: 1992, month: 3, day: 13 },
        }),
      );
    });

    it('should wrap plain string values in {value: ...}', async () => {
      const insertedClaim = {
        id: 'claim-1',
        family_id: 'fam1',
        claim_type: 'personality_trait',
        subject: 'John',
        claim_value: { value: 'kind' },
        conversation_event_id: 'event-1',
        claimed_by: 'user-1',
        claimed_at: new Date().toISOString(),
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const chain = createChainableMock({ data: insertedClaim, error: null });
      mockSupabaseClient.from.mockReturnValue(chain);

      await claimRepo.createFromExtracted(
        'fam1',
        {
          claimType: 'personality_trait',
          subject: 'John',
          claimValue: 'kind',
          confidence: 'medium' as const,
        },
        'event-1',
        'user-1',
      );

      expect(chain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          claim_value: { value: 'kind' },
        }),
      );
    });

    it('should wrap JSON primitive values in {value: ...}', async () => {
      // JSON.parse("42") returns the number 42, not an object
      const insertedClaim = {
        id: 'claim-1',
        family_id: 'fam1',
        claim_type: 'age',
        subject: 'John',
        claim_value: { value: '42' },
        conversation_event_id: 'event-1',
        claimed_by: 'user-1',
        claimed_at: new Date().toISOString(),
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const chain = createChainableMock({ data: insertedClaim, error: null });
      mockSupabaseClient.from.mockReturnValue(chain);

      // "42" is valid JSON but parses to a number, not an object
      await claimRepo.createFromExtracted(
        'fam1',
        {
          claimType: 'age',
          subject: 'John',
          claimValue: '42',
          confidence: 'high' as const,
        },
        'event-1',
        'user-1',
      );

      expect(chain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          claim_value: { value: '42' },
        }),
      );
    });

    it('should handle complex nested JSON objects', async () => {
      const complexValue = {
        year: 1992,
        month: 3,
        day: 13,
        text: 'March 13, 1992',
        precision: 'day',
      };

      const insertedClaim = {
        id: 'claim-1',
        family_id: 'fam1',
        claim_type: 'birth_date',
        subject: 'John',
        claim_value: complexValue,
        conversation_event_id: 'event-1',
        claimed_by: 'user-1',
        claimed_at: new Date().toISOString(),
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const chain = createChainableMock({ data: insertedClaim, error: null });
      mockSupabaseClient.from.mockReturnValue(chain);

      await claimRepo.createFromExtracted(
        'fam1',
        {
          claimType: 'birth_date',
          subject: 'John',
          claimValue: JSON.stringify(complexValue),
          confidence: 'high' as const,
        },
        'event-1',
        'user-1',
      );

      expect(chain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          claim_value: complexValue,
        }),
      );
    });

    it('should handle malformed JSON gracefully', async () => {
      // Invalid JSON should be wrapped as plain string
      const insertedClaim = {
        id: 'claim-1',
        family_id: 'fam1',
        claim_type: 'note',
        subject: 'John',
        claim_value: { value: '{not valid json' },
        conversation_event_id: 'event-1',
        claimed_by: 'user-1',
        claimed_at: new Date().toISOString(),
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const chain = createChainableMock({ data: insertedClaim, error: null });
      mockSupabaseClient.from.mockReturnValue(chain);

      await claimRepo.createFromExtracted(
        'fam1',
        {
          claimType: 'note',
          subject: 'John',
          claimValue: '{not valid json',
          confidence: 'low' as const,
        },
        'event-1',
        'user-1',
      );

      expect(chain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          claim_value: { value: '{not valid json' },
        }),
      );
    });
  });

  describe('extraction version tracking', () => {
    it('should include extraction version when provided', async () => {
      const insertedClaim = {
        id: 'claim-1',
        family_id: 'fam1',
        claim_type: 'birth_year',
        subject: 'John',
        claim_value: { year: 1990 },
        conversation_event_id: 'event-1',
        claimed_by: 'user-1',
        claimed_at: new Date().toISOString(),
        status: 'active',
        extraction_version: 'intern-v0.1.0+scribe-v0.2.0+registrar-v0.1.0',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const chain = createChainableMock({ data: insertedClaim, error: null });
      mockSupabaseClient.from.mockReturnValue(chain);

      await claimRepo.createFromExtracted(
        'fam1',
        {
          claimType: 'birth_year',
          subject: 'John',
          claimValue: '{"year": 1990}',
          confidence: 'high' as const,
        },
        'event-1',
        'user-1',
        'intern-v0.1.0+scribe-v0.2.0+registrar-v0.1.0',
      );

      expect(chain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          extraction_version: 'intern-v0.1.0+scribe-v0.2.0+registrar-v0.1.0',
        }),
      );
    });
  });
});

describe('ClaimRepository - addConflict', () => {
  let claimRepo: ClaimRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    claimRepo = new ClaimRepository(mockSupabaseClient as any);
  });

  it('should insert bidirectional conflict links', async () => {
    const chain = createChainableMock({ data: null, error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    await claimRepo.addConflict('fam1', 'claim-1', 'claim-2');

    expect(chain.insert).toHaveBeenCalledWith([
      {
        family_id: 'fam1',
        claim_id: 'claim-1',
        conflicts_with_claim_id: 'claim-2',
      },
      {
        family_id: 'fam1',
        claim_id: 'claim-2',
        conflicts_with_claim_id: 'claim-1',
      },
    ]);
  });

  it('should silently ignore unique constraint violations', async () => {
    const chain = createChainableMock({
      data: null,
      error: { code: '23505', message: 'Unique violation' },
    });
    mockSupabaseClient.from.mockReturnValue(chain);

    // Should not throw
    await expect(
      claimRepo.addConflict('fam1', 'claim-1', 'claim-2'),
    ).resolves.not.toThrow();
  });

  it('should throw for other errors', async () => {
    const chain = createChainableMock({
      data: null,
      error: { code: '42P01', message: 'Table not found' },
    });
    mockSupabaseClient.from.mockReturnValue(chain);

    await expect(
      claimRepo.addConflict('fam1', 'claim-1', 'claim-2'),
    ).rejects.toThrow('Failed to add claim conflict');
  });
});
