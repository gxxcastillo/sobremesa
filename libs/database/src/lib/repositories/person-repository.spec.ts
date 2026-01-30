import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PersonRepository } from './person-repository';

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
  chain.or = vi.fn().mockReturnValue(chain);
  chain.ilike = vi.fn().mockReturnValue(chain);
  chain.contains = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue(finalResult);
  // For operations that don't call single()
  chain.then = (resolve: (value: { data: unknown; error: unknown }) => void) =>
    resolve(finalResult);
  return chain;
};

describe('PersonRepository - isDescriptiveName', () => {
  let personRepo: PersonRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    personRepo = new PersonRepository(mockSupabaseClient as any);
  });

  // Access private method for testing
  const isDescriptiveName = (name: string): boolean => {
    return (personRepo as any).isDescriptiveName(name);
  };

  describe('English possessive relationships', () => {
    it('should detect "Ralph\'s sister" as descriptive', () => {
      expect(isDescriptiveName("Ralph's sister")).toBe(true);
    });

    it('should detect "Timothy\'s son" as descriptive', () => {
      expect(isDescriptiveName("Timothy's son")).toBe(true);
    });

    it('should detect "Eddie\'s ex-wife" as descriptive', () => {
      expect(isDescriptiveName("Eddie's ex-wife")).toBe(true);
    });

    it('should NOT detect "Ralph" as descriptive', () => {
      expect(isDescriptiveName('Ralph')).toBe(false);
    });
  });

  describe('Spanish possessive relationships', () => {
    it('should detect "la hermana de Ralph" as descriptive', () => {
      expect(isDescriptiveName('la hermana de Ralph')).toBe(true);
    });

    it('should detect "el hijo de Timothy" as descriptive', () => {
      expect(isDescriptiveName('el hijo de Timothy')).toBe(true);
    });

    it('should detect "la ex-esposa de Eddie" as descriptive', () => {
      expect(isDescriptiveName('la ex-esposa de Eddie')).toBe(true);
    });

    it('should detect "el primo de Maria" as descriptive', () => {
      expect(isDescriptiveName('el primo de Maria')).toBe(true);
    });

    it('should detect "la abuela de Juan" as descriptive', () => {
      expect(isDescriptiveName('la abuela de Juan')).toBe(true);
    });

    it('should NOT detect "Maria de los Angeles" as descriptive (name with "de")', () => {
      // This contains "de" but no relationship word before it
      expect(isDescriptiveName('Maria de los Angeles')).toBe(false);
    });
  });

  describe('English generic descriptors', () => {
    it('should detect "the neighbor" as descriptive', () => {
      expect(isDescriptiveName('the neighbor')).toBe(true);
    });

    it('should detect "unknown man" as descriptive', () => {
      expect(isDescriptiveName('unknown man')).toBe(true);
    });

    it('should detect "that friend" as descriptive', () => {
      expect(isDescriptiveName('that friend')).toBe(true);
    });

    it('should detect "someone" as descriptive', () => {
      expect(isDescriptiveName('someone')).toBe(true);
    });

    it('should detect "somebody" as descriptive', () => {
      expect(isDescriptiveName('somebody')).toBe(true);
    });
  });

  describe('Spanish generic descriptors', () => {
    it('should detect "el vecino" as descriptive', () => {
      expect(isDescriptiveName('el vecino')).toBe(true);
    });

    it('should detect "la vecina" as descriptive', () => {
      expect(isDescriptiveName('la vecina')).toBe(true);
    });

    it('should detect "un hombre" as descriptive', () => {
      expect(isDescriptiveName('un hombre')).toBe(true);
    });

    it('should detect "una mujer" as descriptive', () => {
      expect(isDescriptiveName('una mujer')).toBe(true);
    });

    it('should detect "alguien" as descriptive', () => {
      expect(isDescriptiveName('alguien')).toBe(true);
    });

    it('should detect "desconocido" as descriptive', () => {
      expect(isDescriptiveName('desconocido')).toBe(true);
    });

    it('should detect "desconocida" as descriptive', () => {
      expect(isDescriptiveName('desconocida')).toBe(true);
    });
  });

  describe('Real names (should NOT be descriptive)', () => {
    it('should NOT detect "John Smith" as descriptive', () => {
      expect(isDescriptiveName('John Smith')).toBe(false);
    });

    it('should NOT detect "María García" as descriptive', () => {
      expect(isDescriptiveName('María García')).toBe(false);
    });

    it('should NOT detect "Robert" as descriptive', () => {
      expect(isDescriptiveName('Robert')).toBe(false);
    });

    it('should NOT detect "Grandmother Rose" as descriptive (name includes relationship)', () => {
      // "Grandmother Rose" is a name, not "the grandmother"
      expect(isDescriptiveName('Grandmother Rose')).toBe(false);
    });
  });
});

describe('PersonRepository - calculateSimilarity', () => {
  let personRepo: PersonRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    personRepo = new PersonRepository(mockSupabaseClient as any);
  });

  // Access private method for testing
  const calculateSimilarity = (a: string, b: string): number => {
    return (personRepo as any).calculateSimilarity(a, b);
  };

  it('should return 1 for identical strings', () => {
    expect(calculateSimilarity('john', 'john')).toBe(1);
  });

  it('should return 0 for empty strings', () => {
    expect(calculateSimilarity('', 'john')).toBe(0);
    expect(calculateSimilarity('john', '')).toBe(0);
  });

  it('should return high similarity for similar names', () => {
    // "john" vs "jon" - 1 character difference
    const similarity = calculateSimilarity('john', 'jon');
    expect(similarity).toBeGreaterThan(0.7);
  });

  it('should return low similarity for different names', () => {
    const similarity = calculateSimilarity('john', 'mary');
    expect(similarity).toBeLessThan(0.5);
  });

  it('should handle common typos with high similarity', () => {
    // "michael" vs "micheal" - common typo (2 edits for transposition, 7 chars = ~0.71)
    const similarity = calculateSimilarity('michael', 'micheal');
    expect(similarity).toBeGreaterThan(0.7);
  });

  it('should handle name variations', () => {
    // "robert" vs "roberto" - name variation (1 char diff, 7 chars max = ~0.86 similarity)
    const similarity = calculateSimilarity('robert', 'roberto');
    expect(similarity).toBeGreaterThan(0.75);
  });

  it('should be case-independent when inputs are lowercased', () => {
    // This tests the algorithm itself; the repository lowercases before comparison
    const sim1 = calculateSimilarity('john', 'john');
    const sim2 = calculateSimilarity('JOHN'.toLowerCase(), 'john');
    expect(sim1).toBe(sim2);
  });
});

describe('PersonRepository - findBestMatch', () => {
  let personRepo: PersonRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    personRepo = new PersonRepository(mockSupabaseClient as any);
  });

  it('should return high confidence for exact name match', async () => {
    const mockPeople = [
      {
        id: '1',
        family_id: 'fam1',
        name: 'John Smith',
        aliases: [],
        redacted: false,
        is_placeholder: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: '2',
        family_id: 'fam1',
        name: 'Jane Doe',
        aliases: [],
        redacted: false,
        is_placeholder: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const chain = createChainableMock({ data: mockPeople, error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await personRepo.findBestMatch('fam1', 'John Smith');

    expect(result).not.toBeNull();
    expect(result?.confidence).toBe('high');
    expect(result?.person.name).toBe('John Smith');
    expect(result?.matchReason).toContain('exact match');
  });

  it('should return high confidence for exact alias match', async () => {
    const mockPeople = [
      {
        id: '1',
        family_id: 'fam1',
        name: 'John Smith',
        aliases: ['Johnny', 'J. Smith'],
        redacted: false,
        is_placeholder: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const chain = createChainableMock({ data: mockPeople, error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await personRepo.findBestMatch('fam1', 'Johnny');

    expect(result).not.toBeNull();
    expect(result?.confidence).toBe('high');
    expect(result?.person.name).toBe('John Smith');
  });

  it('should return medium confidence for unambiguous first-name match', async () => {
    const mockPeople = [
      {
        id: '1',
        family_id: 'fam1',
        name: 'John Smith',
        aliases: [],
        redacted: false,
        is_placeholder: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: '2',
        family_id: 'fam1',
        name: 'Jane Doe',
        aliases: [],
        redacted: false,
        is_placeholder: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const chain = createChainableMock({ data: mockPeople, error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await personRepo.findBestMatch('fam1', 'John');

    expect(result).not.toBeNull();
    expect(result?.confidence).toBe('medium');
    expect(result?.person.name).toBe('John Smith');
    expect(result?.matchReason).toContain('first-name match');
  });

  it('should return null for ambiguous first-name match (multiple Johns)', async () => {
    const mockPeople = [
      {
        id: '1',
        family_id: 'fam1',
        name: 'John Smith',
        aliases: [],
        redacted: false,
        is_placeholder: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: '2',
        family_id: 'fam1',
        name: 'John Doe',
        aliases: [],
        redacted: false,
        is_placeholder: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const chain = createChainableMock({ data: mockPeople, error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await personRepo.findBestMatch('fam1', 'John');

    // Should be null because it's ambiguous
    expect(result).toBeNull();
  });

  it('should return medium confidence for fuzzy match above threshold', async () => {
    const mockPeople = [
      {
        id: '1',
        family_id: 'fam1',
        name: 'Michael Johnson',
        aliases: [],
        redacted: false,
        is_placeholder: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const chain = createChainableMock({ data: mockPeople, error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    // "Micheal" is a common typo for "Michael"
    const result = await personRepo.findBestMatch('fam1', 'Micheal Johnson');

    expect(result).not.toBeNull();
    expect(result?.confidence).toBe('medium');
    expect(result?.matchReason).toContain('fuzzy match');
  });

  it('should return null when no matches found', async () => {
    const mockPeople = [
      {
        id: '1',
        family_id: 'fam1',
        name: 'John Smith',
        aliases: [],
        redacted: false,
        is_placeholder: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const chain = createChainableMock({ data: mockPeople, error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await personRepo.findBestMatch('fam1', 'Robert Williams');

    expect(result).toBeNull();
  });

  it('should return null when no people exist', async () => {
    const chain = createChainableMock({ data: [], error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await personRepo.findBestMatch('fam1', 'Anyone');

    expect(result).toBeNull();
  });

  it('should match against search aliases too', async () => {
    const mockPeople = [
      {
        id: '1',
        family_id: 'fam1',
        name: 'Robert Johnson',
        aliases: ['Bob', 'Bobby'],
        redacted: false,
        is_placeholder: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const chain = createChainableMock({ data: mockPeople, error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    // Search with an alias that matches the person's name
    const result = await personRepo.findBestMatch('fam1', 'Rob', ['Bobby']);

    expect(result).not.toBeNull();
    expect(result?.confidence).toBe('high');
    expect(result?.person.name).toBe('Robert Johnson');
  });

  it('should be case-insensitive', async () => {
    const mockPeople = [
      {
        id: '1',
        family_id: 'fam1',
        name: 'John Smith',
        aliases: [],
        redacted: false,
        is_placeholder: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const chain = createChainableMock({ data: mockPeople, error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await personRepo.findBestMatch('fam1', 'JOHN SMITH');

    expect(result).not.toBeNull();
    expect(result?.confidence).toBe('high');
  });
});

describe('PersonRepository - updateName', () => {
  let personRepo: PersonRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    personRepo = new PersonRepository(mockSupabaseClient as any);
  });

  it('should add old name as alias when updating name', async () => {
    const existingPerson = {
      id: 'p1',
      family_id: 'fam1',
      name: "Ralph's sister",
      aliases: [],
      redacted: false,
      is_placeholder: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const updatedPerson = {
      ...existingPerson,
      name: 'Sarah Johnson',
      aliases: ["Ralph's sister"],
    };

    // First call: findById
    const findChain = createChainableMock({
      data: existingPerson,
      error: null,
    });
    // Second call: update
    const updateChain = createChainableMock({
      data: updatedPerson,
      error: null,
    });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? findChain : updateChain;
    });

    await personRepo.updateName('fam1', 'p1', 'Sarah Johnson');

    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Sarah Johnson',
        aliases: expect.arrayContaining(["Ralph's sister"]),
      }),
    );
  });

  it('should not add duplicate alias if old name already in aliases', async () => {
    const existingPerson = {
      id: 'p1',
      family_id: 'fam1',
      name: 'Bob',
      aliases: ['Bobby', 'Robert'],
      redacted: false,
      is_placeholder: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const findChain = createChainableMock({
      data: existingPerson,
      error: null,
    });
    const updateChain = createChainableMock({
      data: { ...existingPerson, name: 'Robert Johnson' },
      error: null,
    });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? findChain : updateChain;
    });

    await personRepo.updateName('fam1', 'p1', 'Robert Johnson');

    const updateCall = updateChain.update.mock.calls[0][0];
    // Should include 'Bob' as new alias, and existing aliases
    expect(updateCall.aliases).toContain('Bob');
    expect(updateCall.aliases).toContain('Bobby');
    expect(updateCall.aliases).toContain('Robert');
    // But no duplicates
    expect(new Set(updateCall.aliases).size).toBe(updateCall.aliases.length);
  });

  it('should skip adding alias when name unchanged', async () => {
    const existingPerson = {
      id: 'p1',
      family_id: 'fam1',
      name: 'John Smith',
      aliases: [],
      redacted: false,
      is_placeholder: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const findChain = createChainableMock({
      data: existingPerson,
      error: null,
    });
    const updateChain = createChainableMock({
      data: existingPerson,
      error: null,
    });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? findChain : updateChain;
    });

    await personRepo.updateName('fam1', 'p1', 'John Smith');

    // Should only update name, not aliases
    const updateCall = updateChain.update.mock.calls[0][0];
    expect(updateCall.name).toBe('John Smith');
    expect(updateCall.aliases).toBeUndefined();
  });

  it('should throw error if person not found', async () => {
    const findChain = createChainableMock({
      data: null,
      error: { code: 'PGRST116', message: 'Not found' },
    });

    mockSupabaseClient.from.mockReturnValue(findChain);

    await expect(
      personRepo.updateName('fam1', 'nonexistent', 'New Name'),
    ).rejects.toThrow('Person not found: nonexistent');
  });
});
