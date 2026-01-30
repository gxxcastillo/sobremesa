import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TimelineEventRepository } from './timeline-event-repository';

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
  chain.in = vi.fn().mockReturnValue(chain);
  chain.ilike = vi.fn().mockReturnValue(chain);
  chain.gte = vi.fn().mockReturnValue(chain);
  chain.lte = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue(finalResult);
  chain.maybeSingle = vi.fn().mockResolvedValue(finalResult);
  chain.then = (resolve: (value: { data: unknown; error: unknown }) => void) =>
    resolve(finalResult);
  return chain;
};

describe('TimelineEventRepository - findSimilar', () => {
  let eventRepo: TimelineEventRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    eventRepo = new TimelineEventRepository(mockSupabaseClient as any);
  });

  it('should return null when no people provided', async () => {
    const result = await eventRepo.findSimilar(
      'fam1',
      'Leaving Cuba',
      [],
      1959,
    );

    expect(result).toBeNull();
    expect(mockSupabaseClient.from).not.toHaveBeenCalled();
  });

  it('should return null when no events have any of the people', async () => {
    const eventPeopleChain = createChainableMock({ data: [], error: null });
    mockSupabaseClient.from.mockReturnValue(eventPeopleChain);

    const result = await eventRepo.findSimilar(
      'fam1',
      'Leaving Cuba',
      ['person-1', 'person-2'],
      1959,
    );

    expect(result).toBeNull();
    expect(mockSupabaseClient.from).toHaveBeenCalledWith('event_people');
  });

  it('should find event with partial person overlap', async () => {
    const existingEvent = {
      id: 'event-1',
      family_id: 'fam1',
      title: 'Leaving Cuba',
      date_year: 1959,
      redacted: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // First call: event_people query - event has person-1 linked
    const eventPeopleChain = createChainableMock({
      data: [{ event_id: 'event-1' }],
      error: null,
    });

    // Second call: events query - find the event
    const eventsChain = createChainableMock({
      data: existingEvent,
      error: null,
    });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation((table: string) => {
      callCount++;
      return callCount === 1 ? eventPeopleChain : eventsChain;
    });

    // Search with person-1 and person-2, but event only has person-1
    const result = await eventRepo.findSimilar(
      'fam1',
      'Leaving Cuba',
      ['person-1', 'person-2'],
      1959,
    );

    expect(result).not.toBeNull();
    expect(result?.id).toBe('event-1');
  });

  it('should match events within ±2 year tolerance', async () => {
    const existingEvent = {
      id: 'event-1',
      family_id: 'fam1',
      title: 'Leaving Cuba',
      date_year: 1958, // 1 year off from search
      redacted: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const eventPeopleChain = createChainableMock({
      data: [{ event_id: 'event-1' }],
      error: null,
    });

    const eventsChain = createChainableMock({
      data: existingEvent,
      error: null,
    });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? eventPeopleChain : eventsChain;
    });

    const result = await eventRepo.findSimilar(
      'fam1',
      'Leaving Cuba',
      ['person-1'],
      1959, // Searching for 1959, event is 1958
    );

    expect(result).not.toBeNull();
    // Verify date range filter was applied
    expect(eventsChain.gte).toHaveBeenCalledWith('date_year', 1957);
    expect(eventsChain.lte).toHaveBeenCalledWith('date_year', 1961);
  });

  it('should use title fuzzy matching', async () => {
    const eventPeopleChain = createChainableMock({
      data: [{ event_id: 'event-1' }],
      error: null,
    });

    const eventsChain = createChainableMock({ data: null, error: null });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? eventPeopleChain : eventsChain;
    });

    await eventRepo.findSimilar('fam1', 'Cuba', ['person-1'], 1959);

    // Verify ilike was used for fuzzy title matching
    expect(eventsChain.ilike).toHaveBeenCalledWith('title', '%Cuba%');
  });
});

describe('TimelineEventRepository - findOrCreate', () => {
  let eventRepo: TimelineEventRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    eventRepo = new TimelineEventRepository(mockSupabaseClient as any);
  });

  it('should return existing event when found', async () => {
    const existingEvent = {
      id: 'event-1',
      family_id: 'fam1',
      title: 'Leaving Cuba',
      date_year: 1959,
      redacted: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // Mock findSimilar to return existing event
    const eventPeopleChain = createChainableMock({
      data: [{ event_id: 'event-1' }],
      error: null,
    });
    const eventsChain = createChainableMock({
      data: existingEvent,
      error: null,
    });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? eventPeopleChain : eventsChain;
    });

    const result = await eventRepo.findOrCreate(
      'fam1',
      { title: 'Leaving Cuba', dateYear: 1959, peopleInvolved: [] },
      ['person-1'],
      undefined,
      'conv-1',
    );

    expect(result.created).toBe(false);
    expect(result.event.id).toBe('event-1');
  });

  it('should create new event when no similar found', async () => {
    const newEvent = {
      id: 'event-new',
      family_id: 'fam1',
      title: 'New Event',
      date_year: 2020,
      redacted: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // First two calls: findSimilar returns nothing
    const eventPeopleChain = createChainableMock({ data: [], error: null });

    // Third call: insert new event
    const insertChain = createChainableMock({ data: newEvent, error: null });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? eventPeopleChain : insertChain;
    });

    const result = await eventRepo.findOrCreate(
      'fam1',
      { title: 'New Event', dateYear: 2020, peopleInvolved: [] },
      ['person-1'],
      undefined,
      'conv-1',
    );

    expect(result.created).toBe(true);
    expect(result.event.id).toBe('event-new');
  });
});
