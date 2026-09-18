import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RecordContextBuilder } from './record-context';
import type {
  Claim,
  ClaimEntity,
  Person,
  Place,
  TimelineEvent,
} from '@sobremesa/shared-types';

function makeClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: 'claim-1',
    familyId: 'fam1',
    claimType: 'date',
    subject: 'Birth year',
    claimValue: { value: 1891 },
    conversationEventId: 'other-event',
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

function makeClaimEntity(overrides: Partial<ClaimEntity> = {}): ClaimEntity {
  return {
    id: 'ce-1',
    familyId: 'fam1',
    claimId: 'claim-1',
    entityId: 'person-1',
    entityType: 'person',
    createdAt: new Date(),
    ...overrides,
  };
}

function makePerson(overrides: Partial<Person> = {}): Person {
  return {
    id: 'person-1',
    familyId: 'fam1',
    name: 'Ricardo',
    aliases: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makePlace(overrides: Partial<Place> = {}): Place {
  return {
    id: 'place-1',
    familyId: 'fam1',
    name: 'Managua',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: 'event-1',
    familyId: 'fam1',
    title: 'The wedding',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('RecordContextBuilder', () => {
  let claimRepo: {
    findByConversationEvent: ReturnType<typeof vi.fn>;
    findByEntity: ReturnType<typeof vi.fn>;
  };
  let claimEntityRepo: { findByClaims: ReturnType<typeof vi.fn> };
  let personRepo: { findByIds: ReturnType<typeof vi.fn> };
  let placeRepo: { findByIds: ReturnType<typeof vi.fn> };
  let timelineEventRepo: { findByIds: ReturnType<typeof vi.fn> };
  let builder: RecordContextBuilder;

  beforeEach(() => {
    claimRepo = {
      findByConversationEvent: vi.fn().mockResolvedValue([]),
      findByEntity: vi.fn().mockResolvedValue([]),
    };
    claimEntityRepo = { findByClaims: vi.fn().mockResolvedValue([]) };
    personRepo = { findByIds: vi.fn().mockResolvedValue([]) };
    placeRepo = { findByIds: vi.fn().mockResolvedValue([]) };
    timelineEventRepo = { findByIds: vi.fn().mockResolvedValue([]) };

    builder = new RecordContextBuilder({
      claimRepo: claimRepo as any,
      claimEntityRepo: claimEntityRepo as any,
      personRepo: personRepo as any,
      placeRepo: placeRepo as any,
      timelineEventRepo: timelineEventRepo as any,
    });
  });

  it('returns the empty-record placeholder and no hints when nothing was named', async () => {
    const result = await builder.build('fam1', 'evt-1');

    expect(result.block).toBe(
      '(nothing else recorded about people/places/events named here)',
    );
    expect(result.hints).toEqual([]);
  });

  it('lists a named person with their prior claims and marks claims from this message', async () => {
    claimRepo.findByConversationEvent.mockResolvedValue([
      makeClaim({ id: 'c1', status: 'active' }),
    ]);
    claimEntityRepo.findByClaims.mockResolvedValue([makeClaimEntity()]);
    personRepo.findByIds.mockResolvedValue([makePerson()]);
    claimRepo.findByEntity.mockResolvedValue([
      makeClaim({
        id: 'c-prior',
        subject: 'Birthplace',
        claimValue: { value: 'León' },
        conversationEventId: 'other-event',
      }),
      makeClaim({
        id: 'c-current',
        subject: 'Occupation',
        claimValue: { value: 'baker' },
        conversationEventId: 'evt-1',
      }),
    ]);

    const result = await builder.build('fam1', 'evt-1');

    expect(personRepo.findByIds).toHaveBeenCalledWith('fam1', ['person-1']);
    expect(claimRepo.findByEntity).toHaveBeenCalledWith(
      'fam1',
      'person',
      'person-1',
    );
    expect(result.block).toContain('People named in this message:');
    expect(result.block).toContain('- Ricardo');
    expect(result.block).toContain('Birthplace — León (date)');
    expect(result.block).toContain(
      '(from this message) Occupation — baker (date)',
    );
  });

  it('caps each side of an entity claim history at 8, keeping the repository order', async () => {
    claimRepo.findByConversationEvent.mockResolvedValue([
      makeClaim({ id: 'c1' }),
    ]);
    claimEntityRepo.findByClaims.mockResolvedValue([makeClaimEntity()]);
    personRepo.findByIds.mockResolvedValue([makePerson()]);
    const priorClaims = Array.from({ length: 10 }, (_, i) =>
      makeClaim({
        id: `prior-${i}`,
        subject: `Fact ${i}`,
        claimValue: { value: i },
        conversationEventId: 'other-event',
      }),
    );
    claimRepo.findByEntity.mockResolvedValue(priorClaims);

    const result = await builder.build('fam1', 'evt-1');

    for (let i = 0; i < 8; i++) {
      expect(result.block).toContain(`Fact ${i}`);
    }
    expect(result.block).not.toContain('Fact 8');
    expect(result.block).not.toContain('Fact 9');
  });

  it('hints at a relational placeholder the record has never identified', async () => {
    claimRepo.findByConversationEvent.mockResolvedValue([
      makeClaim({ id: 'c1' }),
    ]);
    claimEntityRepo.findByClaims.mockResolvedValue([makeClaimEntity()]);
    personRepo.findByIds.mockResolvedValue([
      makePerson({ name: "Ricardo's father", isPlaceholder: true }),
    ]);
    claimRepo.findByEntity.mockResolvedValue([]);

    const result = await builder.build('fam1', 'evt-1');

    expect(result.block).toContain('[unnamed placeholder]');
    expect(result.hints).toContain(
      '"Ricardo\'s father" is a named person the record has never identified.',
    );
  });

  it('lists a named place', async () => {
    claimRepo.findByConversationEvent.mockResolvedValue([
      makeClaim({ id: 'c1' }),
    ]);
    claimEntityRepo.findByClaims.mockResolvedValue([
      makeClaimEntity({ entityId: 'place-1', entityType: 'place' }),
    ]);
    placeRepo.findByIds.mockResolvedValue([makePlace()]);
    claimRepo.findByEntity.mockResolvedValue([]);

    const result = await builder.build('fam1', 'evt-1');

    expect(placeRepo.findByIds).toHaveBeenCalledWith('fam1', ['place-1']);
    expect(result.block).toContain('Places named in this message:');
    expect(result.block).toContain('- Managua');
  });

  it('hints at an event with no recorded date', async () => {
    claimRepo.findByConversationEvent.mockResolvedValue([
      makeClaim({ id: 'c1' }),
    ]);
    claimEntityRepo.findByClaims.mockResolvedValue([
      makeClaimEntity({ entityId: 'event-1', entityType: 'event' }),
    ]);
    timelineEventRepo.findByIds.mockResolvedValue([makeEvent()]);
    claimRepo.findByEntity.mockResolvedValue([]);

    const result = await builder.build('fam1', 'evt-1');

    expect(result.block).toContain('[no recorded date]');
    expect(result.hints).toContain(
      'The event "The wedding" has no recorded date.',
    );
  });

  it('does not hint at a dated event', async () => {
    claimRepo.findByConversationEvent.mockResolvedValue([
      makeClaim({ id: 'c1' }),
    ]);
    claimEntityRepo.findByClaims.mockResolvedValue([
      makeClaimEntity({ entityId: 'event-1', entityType: 'event' }),
    ]);
    timelineEventRepo.findByIds.mockResolvedValue([
      makeEvent({ dateYear: 1959 }),
    ]);
    claimRepo.findByEntity.mockResolvedValue([]);

    const result = await builder.build('fam1', 'evt-1');

    expect(result.block).toContain('(1959)');
    expect(result.hints).not.toContain(
      'The event "The wedding" has no recorded date.',
    );
  });

  it('hints when this message touches a disputed claim', async () => {
    claimRepo.findByConversationEvent.mockResolvedValue([
      makeClaim({ id: 'c1', status: 'disputed' }),
    ]);
    claimEntityRepo.findByClaims.mockResolvedValue([makeClaimEntity()]);
    personRepo.findByIds.mockResolvedValue([makePerson()]);
    claimRepo.findByEntity.mockResolvedValue([]);

    const result = await builder.build('fam1', 'evt-1');

    expect(result.hints).toContain(
      'This message touches a claim the record has flagged as disputed/contradicted.',
    );
  });

  it('skips the entity lookups entirely when the message produced no claims', async () => {
    claimRepo.findByConversationEvent.mockResolvedValue([]);

    await builder.build('fam1', 'evt-1');

    expect(claimEntityRepo.findByClaims).not.toHaveBeenCalled();
    expect(personRepo.findByIds).not.toHaveBeenCalled();
  });
});
