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

const makeEventRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'event-1',
  family_id: 'fam1',
  title: 'Leaving Cuba',
  event_type: null,
  date_text: null,
  date_year: 1959,
  place_id: null,
  conversation_event_id: 'conv-1',
  claimed_by: null,
  redacted: false,
  extraction_version: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
});

describe('TimelineEventRepository - findSimilar', () => {
  let eventRepo: TimelineEventRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    eventRepo = new TimelineEventRepository(mockSupabaseClient as any);
  });

  it('should return null when no candidates exist and no personIds', async () => {
    // No personIds → calls findAllActive → returns empty
    const eventsChain = createChainableMock({ data: [], error: null });
    mockSupabaseClient.from.mockReturnValue(eventsChain);

    const result = await eventRepo.findSimilar('fam1', 'Leaving Cuba', []);

    expect(result).toBeNull();
    // Should query events table via findAllActive
    expect(mockSupabaseClient.from).toHaveBeenCalledWith('events');
  });

  it('should return null when event_people has no matches and findAllActive is empty', async () => {
    // event_people returns empty → falls through to findAllActive → also empty
    const emptyChain = createChainableMock({ data: [], error: null });
    mockSupabaseClient.from.mockReturnValue(emptyChain);

    const result = await eventRepo.findSimilar('fam1', 'Leaving Cuba', [
      'person-1',
    ]);

    expect(result).toBeNull();
    expect(mockSupabaseClient.from).toHaveBeenCalledWith('event_people');
    expect(mockSupabaseClient.from).toHaveBeenCalledWith('events');
  });

  it('should match event with identical title via person candidates', async () => {
    const event = makeEventRow();

    // Call 1: event_people → find person's events
    const eventPeopleChain = createChainableMock({
      data: [{ event_id: 'event-1' }],
      error: null,
    });

    // Call 2: events → fetch candidate events
    const eventsChain = createChainableMock({
      data: [event],
      error: null,
    });

    // Call 3: event_people → batch person overlap check
    const overlapChain = createChainableMock({
      data: [{ event_id: 'event-1', person_id: 'person-1' }],
      error: null,
    });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return eventPeopleChain;
      if (callCount === 2) return eventsChain;
      return overlapChain;
    });

    const result = await eventRepo.findSimilar(
      'fam1',
      'Leaving Cuba',
      ['person-1'],
      1959,
    );

    expect(result).not.toBeNull();
    expect(result?.id).toBe('event-1');
  });

  it('should return null when title is completely different', async () => {
    const event = makeEventRow({ title: 'Wedding reception' });

    const eventPeopleChain = createChainableMock({
      data: [{ event_id: 'event-1' }],
      error: null,
    });

    const eventsChain = createChainableMock({
      data: [event],
      error: null,
    });

    const overlapChain = createChainableMock({
      data: [{ event_id: 'event-1', person_id: 'person-1' }],
      error: null,
    });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return eventPeopleChain;
      if (callCount === 2) return eventsChain;
      return overlapChain;
    });

    // "Leaving Cuba" vs "Wedding reception" — no word overlap → score < 0.6
    const result = await eventRepo.findSimilar(
      'fam1',
      'Leaving Cuba',
      ['person-1'],
      1959,
    );

    expect(result).toBeNull();
  });

  it('should match event with rephrased title via word overlap when dates anchor it', async () => {
    const event = makeEventRow({
      title: 'High school football game',
      date_year: 1962,
    });

    // No personIds → findAllActive
    const eventsChain = createChainableMock({
      data: [event],
      error: null,
    });

    mockSupabaseClient.from.mockReturnValue(eventsChain);

    // "football game loss" vs "High school football game"
    // tokens: ["football", "game", "loss"] vs ["high", "school", "football", "game"]
    // overlap: 2 / min(3, 4) = 0.67; corroborating dates +0.15 → 0.82 ≥ 0.6 → match
    const result = await eventRepo.findSimilar(
      'fam1',
      'football game loss',
      [],
      1962,
    );

    expect(result).not.toBeNull();
    expect(result?.id).toBe('event-1');
  });

  it('should NOT merge on title alone with no people and no dates (#2)', async () => {
    // The over-merge this fixes: a generic-titled, person-less event collapsing
    // into any title-overlapping event with no corroborating signal.
    const event = makeEventRow({
      title: 'High school football game',
      date_year: null,
    });
    const eventsChain = createChainableMock({ data: [event], error: null });
    mockSupabaseClient.from.mockReturnValue(eventsChain);

    // Identical-ish title, but no personIds and no dateYear → no structural anchor
    const result = await eventRepo.findSimilar('fam1', 'football game', []);

    expect(result).toBeNull();
  });

  it('should NOT merge same-title events years apart even with a shared person (#1)', async () => {
    // 'Birthday Party' 1950 vs 1990 with a shared person must stay distinct.
    const event = makeEventRow({ title: 'Birthday Party', date_year: 1950 });

    const eventPeopleChain = createChainableMock({
      data: [{ event_id: 'event-1' }],
      error: null,
    });
    const eventsChain = createChainableMock({ data: [event], error: null });
    const overlapChain = createChainableMock({
      data: [{ event_id: 'event-1', person_id: 'person-1' }],
      error: null,
    });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return eventPeopleChain;
      if (callCount === 2) return eventsChain;
      return overlapChain;
    });

    const result = await eventRepo.findSimilar(
      'fam1',
      'Birthday Party',
      ['person-1'],
      1990,
    );

    expect(result).toBeNull();
  });

  it('should NOT merge dated events 3-5 years apart (closed the no-penalty gap, #1)', async () => {
    // Previously a 3-5yr gap got neither boost nor penalty, so identical titles
    // merged. Now it is outside MAX_YEAR_GAP and hard-filtered out.
    const event = makeEventRow({ title: 'Birthday Party', date_year: 1990 });
    const eventsChain = createChainableMock({ data: [event], error: null });
    mockSupabaseClient.from.mockReturnValue(eventsChain);

    const result = await eventRepo.findSimilar(
      'fam1',
      'Birthday Party',
      [],
      1994,
    );

    expect(result).toBeNull();
  });

  it('should apply date proximity boost for close dates', async () => {
    const event = makeEventRow({
      title: 'Leaving Cuba',
      date_year: 1958, // 1 year off
    });

    const eventsChain = createChainableMock({
      data: [event],
      error: null,
    });
    mockSupabaseClient.from.mockReturnValue(eventsChain);

    const result = await eventRepo.findSimilar(
      'fam1',
      'Leaving Cuba',
      [],
      1959,
    );

    // Title overlap = 1.0, date boost +0.15 → 1.15 ≥ 0.6
    expect(result).not.toBeNull();
  });

  it('should apply date distance penalty for far dates', async () => {
    // Title with partial overlap that would score ~0.67 without penalty
    const event = makeEventRow({
      title: 'High school football game',
      date_year: 1950, // 10+ years off
    });

    const eventsChain = createChainableMock({
      data: [event],
      error: null,
    });
    mockSupabaseClient.from.mockReturnValue(eventsChain);

    // Both dated but 12 years apart (> MAX_YEAR_GAP) → candidate hard-filtered out
    const result = await eventRepo.findSimilar(
      'fam1',
      'football game loss',
      [],
      1962,
    );

    expect(result).toBeNull();
  });

  it('should pick the best scoring candidate among multiple', async () => {
    const goodMatch = makeEventRow({
      id: 'event-good',
      title: 'Leaving Cuba for Miami',
      date_year: 1959,
    });
    const poorMatch = makeEventRow({
      id: 'event-poor',
      title: 'Wedding in Havana',
      date_year: 1959,
    });

    const eventsChain = createChainableMock({
      data: [goodMatch, poorMatch],
      error: null,
    });
    mockSupabaseClient.from.mockReturnValue(eventsChain);

    const result = await eventRepo.findSimilar(
      'fam1',
      'Leaving Cuba',
      [],
      1959,
    );

    expect(result).not.toBeNull();
    expect(result?.id).toBe('event-good');
  });
});

describe('TimelineEventRepository - findOrCreate', () => {
  let eventRepo: TimelineEventRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    eventRepo = new TimelineEventRepository(mockSupabaseClient as any);
  });

  it('should return existing event when found', async () => {
    const existingEvent = makeEventRow();

    // findSimilar calls: event_people → events → person overlap batch
    const eventPeopleChain = createChainableMock({
      data: [{ event_id: 'event-1' }],
      error: null,
    });
    const eventsChain = createChainableMock({
      data: [existingEvent],
      error: null,
    });
    const overlapChain = createChainableMock({
      data: [{ event_id: 'event-1', person_id: 'person-1' }],
      error: null,
    });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return eventPeopleChain;
      if (callCount === 2) return eventsChain;
      return overlapChain;
    });

    const result = await eventRepo.findOrCreate(
      'fam1',
      {
        title: 'Leaving Cuba',
        dateYear: 1959,
        peopleInvolved: [],
        confidence: 'high',
      },
      ['person-1'],
      undefined,
      'conv-1',
    );

    expect(result.created).toBe(false);
    expect(result.event.id).toBe('event-1');
  });

  it('should create new event when no similar found', async () => {
    const newEvent = makeEventRow({
      id: 'event-new',
      title: 'New Event',
      date_year: 2020,
    });

    // findSimilar: event_people → empty, findAllActive → empty
    const emptyChain = createChainableMock({ data: [], error: null });

    // createFromExtracted: insert → returns new event
    const insertChain = createChainableMock({ data: newEvent, error: null });

    let callCount = 0;
    mockSupabaseClient.from.mockImplementation(() => {
      callCount++;
      // Calls 1-2: findSimilar (event_people empty → findAllActive empty)
      if (callCount <= 2) return emptyChain;
      // Call 3: insert
      return insertChain;
    });

    const result = await eventRepo.findOrCreate(
      'fam1',
      {
        title: 'New Event',
        dateYear: 2020,
        peopleInvolved: [],
        confidence: 'medium',
      },
      ['person-1'],
      undefined,
      'conv-1',
    );

    expect(result.created).toBe(true);
    expect(result.event.id).toBe('event-new');
  });
});
