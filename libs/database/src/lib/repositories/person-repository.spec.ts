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

  it('should not first-name-match a description of a real person (F2)', async () => {
    const mockPeople = [
      {
        id: '1',
        family_id: 'fam1',
        name: 'Ricardo Hermoso',
        aliases: [],
        redacted: false,
        is_placeholder: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const chain = createChainableMock({ data: mockPeople, error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await personRepo.findBestMatch(
      'fam1',
      "Ricardo Hermoso's father",
    );

    expect(result).toBeNull();
  });

  it('should still exact-match a description already stored as a real alias (F2)', async () => {
    const mockPeople = [
      {
        id: '1',
        family_id: 'fam1',
        name: 'Robert Williams',
        aliases: ["Ralph's sister"],
        redacted: false,
        is_placeholder: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const chain = createChainableMock({ data: mockPeople, error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await personRepo.findBestMatch('fam1', "Ralph's sister");

    expect(result).not.toBeNull();
    expect(result?.confidence).toBe('high');
    expect(result?.person.name).toBe('Robert Williams');
  });

  it('should still first-name-match a real (non-descriptive) name (F2)', async () => {
    const mockPeople = [
      {
        id: '1',
        family_id: 'fam1',
        name: 'Ricardo Hermoso',
        aliases: [],
        redacted: false,
        is_placeholder: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const chain = createChainableMock({ data: mockPeople, error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await personRepo.findBestMatch('fam1', 'Ricardo');

    expect(result).not.toBeNull();
    expect(result?.confidence).toBe('medium');
    expect(result?.person.name).toBe('Ricardo Hermoso');
  });

  it('should not let a description alias drive pass 2 first-name matching (F2)', async () => {
    const mockPeople = [
      {
        id: '1',
        family_id: 'fam1',
        name: 'Ricardo Hermoso',
        aliases: [],
        redacted: false,
        is_placeholder: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const chain = createChainableMock({ data: mockPeople, error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    // Name is a plain non-matching name; the description is passed as a search alias.
    const result = await personRepo.findBestMatch('fam1', 'Carol', [
      "Ricardo Hermoso's father",
    ]);

    expect(result).toBeNull();
  });

  it('should not fuzzy-match one description against a similar description (F2)', async () => {
    const mockPeople = [
      {
        id: '1',
        family_id: 'fam1',
        name: 'Mario Gomez',
        aliases: ["Mario's son"],
        redacted: false,
        is_placeholder: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const chain = createChainableMock({ data: mockPeople, error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await personRepo.findBestMatch('fam1', "Maria's son");

    expect(result).toBeNull();
  });

  it('should not match a search alias that is a speaker-relative term (F4)', async () => {
    // Simulates a pre-fix row that still carries a speaker-relative alias
    // (no backfill) -- a later mention of "mi tía" must not resolve to it,
    // since "mi tía" names a different person for every speaker.
    const mockPeople = [
      {
        id: '1',
        family_id: 'fam1',
        name: 'Geraldine',
        aliases: ['mi tía'],
        redacted: false,
        is_placeholder: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const chain = createChainableMock({ data: mockPeople, error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await personRepo.findBestMatch('fam1', 'Someone Else', [
      'mi tía',
    ]);

    expect(result).toBeNull();
  });

  it('should not match a speaker-relative name against a real person by first name/fuzzy (F4)', async () => {
    const mockPeople = [
      {
        id: '1',
        family_id: 'fam1',
        name: 'Mi Amigo',
        aliases: [],
        redacted: false,
        is_placeholder: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const chain = createChainableMock({ data: mockPeople, error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await personRepo.findBestMatch('fam1', 'mi amigo');

    expect(result).toBeNull();
  });
});

describe('PersonRepository - findPlaceholderByNormalizedName', () => {
  let personRepo: PersonRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    personRepo = new PersonRepository(mockSupabaseClient as any);
  });

  it('matches a placeholder by normalized name (curly apostrophe, accent, casing) (F3)', async () => {
    const mockPlaceholders = [
      {
        id: '1',
        family_id: 'fam1',
        name: "Ricardo Hermoso's father",
        aliases: [],
        redacted: false,
        is_placeholder: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const chain = createChainableMock({ data: mockPlaceholders, error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await personRepo.findPlaceholderByNormalizedName(
      'fam1',
      'RICARDO HERMOSO’S FATHER',
    );

    expect(result).not.toBeNull();
    expect(result?.id).toBe('1');
  });

  it('filters to non-redacted placeholders server-side (F3)', async () => {
    const chain = createChainableMock({ data: [], error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    await personRepo.findPlaceholderByNormalizedName(
      'fam1',
      "Ricardo Hermoso's father",
    );

    expect(chain.eq).toHaveBeenCalledWith('is_placeholder', true);
    expect(chain.eq).toHaveBeenCalledWith('redacted', false);
  });

  it('does not match on an alias, only the name field (F3)', async () => {
    const mockPlaceholders = [
      {
        id: '1',
        family_id: 'fam1',
        name: 'Unknown',
        aliases: ["Ricardo Hermoso's father"],
        redacted: false,
        is_placeholder: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const chain = createChainableMock({ data: mockPlaceholders, error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await personRepo.findPlaceholderByNormalizedName(
      'fam1',
      "Ricardo Hermoso's father",
    );

    expect(result).toBeNull();
  });

  it('returns null when no placeholders exist', async () => {
    const chain = createChainableMock({ data: [], error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await personRepo.findPlaceholderByNormalizedName(
      'fam1',
      "Ricardo Hermoso's father",
    );

    expect(result).toBeNull();
  });

  it('does not match a similar-but-distinct description ("Maria\'s son" vs "Mario\'s son") (F3)', async () => {
    const mockPlaceholders = [
      {
        id: '1',
        family_id: 'fam1',
        name: "Mario's son",
        aliases: [],
        redacted: false,
        is_placeholder: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const chain = createChainableMock({ data: mockPlaceholders, error: null });
    mockSupabaseClient.from.mockReturnValue(chain);

    const result = await personRepo.findPlaceholderByNormalizedName(
      'fam1',
      "Maria's son",
    );

    expect(result).toBeNull();
  });
});

describe('PersonRepository - durable aliases', () => {
  let personRepo: PersonRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    personRepo = new PersonRepository(mockSupabaseClient as any);
  });

  it('does not persist speaker-relative aliases through updateAliases', async () => {
    const chain = createChainableMock({
      data: {
        id: '1',
        family_id: 'fam1',
        name: 'Geraldine',
        aliases: ['Gerie'],
        redacted: false,
        is_placeholder: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      error: null,
    });
    mockSupabaseClient.from.mockReturnValue(chain);

    await personRepo.updateAliases('fam1', '1', ['Gerie', 'mi tía']);

    expect(chain.update).toHaveBeenCalledWith({ aliases: ['Gerie'] });
  });

  it('does not store a speaker-relative description on a new placeholder', async () => {
    // Stored, it would be the key findPlaceholderByDescription reuses, so a
    // second speaker's "mi papá" would merge into the first speaker's father.
    const chain = createChainableMock({
      data: {
        id: 'p1',
        family_id: 'fam1',
        name: 'Unknown',
        aliases: ['related-to:r1'],
        redacted: false,
        is_placeholder: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      error: null,
    });
    mockSupabaseClient.from.mockReturnValue(chain);

    await personRepo.createPlaceholder('fam1', 'mi papá', ['r1']);

    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ aliases: ['related-to:r1'] }),
    );
  });

  it('keeps a relational description on a new placeholder', async () => {
    const chain = createChainableMock({
      data: {
        id: 'p1',
        family_id: 'fam1',
        name: 'Unknown',
        aliases: ["Ricardo's father", 'related-to:r1'],
        redacted: false,
        is_placeholder: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      error: null,
    });
    mockSupabaseClient.from.mockReturnValue(chain);

    await personRepo.createPlaceholder('fam1', "Ricardo's father", ['r1']);

    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        aliases: ["Ricardo's father", 'related-to:r1'],
      }),
    );
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
