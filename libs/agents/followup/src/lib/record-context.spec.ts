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
  let personRepo: {
    findByIds: ReturnType<typeof vi.fn>;
    findAllActive: ReturnType<typeof vi.fn>;
  };
  let placeRepo: {
    findByIds: ReturnType<typeof vi.fn>;
    findAllActive: ReturnType<typeof vi.fn>;
  };
  let timelineEventRepo: { findByIds: ReturnType<typeof vi.fn> };
  let builder: RecordContextBuilder;

  beforeEach(() => {
    claimRepo = {
      findByConversationEvent: vi.fn().mockResolvedValue([]),
      findByEntity: vi.fn().mockResolvedValue([]),
    };
    claimEntityRepo = { findByClaims: vi.fn().mockResolvedValue([]) };
    personRepo = {
      findByIds: vi.fn().mockResolvedValue([]),
      findAllActive: vi.fn().mockResolvedValue([]),
    };
    placeRepo = {
      findByIds: vi.fn().mockResolvedValue([]),
      findAllActive: vi.fn().mockResolvedValue([]),
    };
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

  describe('text-only fallback on an ignored message (#10)', () => {
    it('reproduces the gap: an ignored message naming a known person gets an empty record without messageText', async () => {
      // No claims at all -- exactly what an Intern-ignored message looks
      // like. Without the fallback (no messageText passed), the record
      // stays empty even though a known person is named.
      personRepo.findAllActive.mockResolvedValue([
        makePerson({ id: 'p-1', name: 'Ricardo Hermoso' }),
      ]);

      const result = await builder.build('fam1', 'evt-1');

      expect(result.block).toBe(
        '(nothing else recorded about people/places/events named here)',
      );
      expect(personRepo.findAllActive).not.toHaveBeenCalled();
    });

    it('finds a known person by name when no claims exist but the text names them', async () => {
      personRepo.findAllActive.mockResolvedValue([
        makePerson({ id: 'p-1', name: 'Ricardo Hermoso' }),
      ]);
      claimRepo.findByEntity.mockResolvedValue([
        makeClaim({
          id: 'c-prior',
          subject: 'Ricardo Hermoso',
          claimValue: { value: 'quit smoking' },
        }),
      ]);

      const result = await builder.build(
        'fam1',
        'evt-1',
        'Does anyone remember when Ricardo Hermoso visited Managua?',
      );

      expect(result.block).toContain('People named in this message:');
      expect(result.block).toContain('- Ricardo Hermoso');
      expect(result.block).toContain('quit smoking');
      // All of a fallback-matched entity's claims are prior -- nothing in
      // this event's own (empty) claim set could be "from this message".
      expect(result.block).not.toContain('(from this message)');
    });

    it('excludes a placeholder from the text-only fallback', async () => {
      personRepo.findAllActive.mockResolvedValue([
        makePerson({
          id: 'p-1',
          name: "Ricardo's father",
          isPlaceholder: true,
        }),
      ]);

      const result = await builder.build(
        'fam1',
        'evt-1',
        "Ricardo's father called yesterday.",
      );

      expect(result.block).toBe(
        '(nothing else recorded about people/places/events named here)',
      );
    });

    it('excludes an ambiguous name shared by two different real people', async () => {
      personRepo.findAllActive.mockResolvedValue([
        makePerson({ id: 'p-1', name: 'Michel Vega' }),
        makePerson({ id: 'p-2', name: 'Michel Vega' }),
      ]);

      const result = await builder.build(
        'fam1',
        'evt-1',
        'Michel Vega called yesterday.',
      );

      expect(result.block).toBe(
        '(nothing else recorded about people/places/events named here)',
      );
      expect(claimRepo.findByEntity).not.toHaveBeenCalled();
    });

    it('caps the fallback at 3 people', async () => {
      personRepo.findAllActive.mockResolvedValue(
        Array.from({ length: 5 }, (_, i) =>
          makePerson({ id: `p-${i}`, name: `Person${i}` }),
        ),
      );

      const result = await builder.build(
        'fam1',
        'evt-1',
        'Person0 Person1 Person2 Person3 Person4 all showed up.',
      );

      expect(result.block).toContain('Person0');
      expect(result.block).toContain('Person1');
      expect(result.block).toContain('Person2');
      expect(result.block).not.toContain('Person3');
      expect(result.block).not.toContain('Person4');
    });

    it('finds a known place by name via the same fallback', async () => {
      placeRepo.findAllActive.mockResolvedValue([makePlace({ name: 'León' })]);

      const result = await builder.build(
        'fam1',
        'evt-1',
        'We used to visit León every summer.',
      );

      expect(result.block).toContain('Places named in this message:');
      expect(result.block).toContain('- León');
    });

    it('does not use the fallback when claim-based entities were already found', async () => {
      claimRepo.findByConversationEvent.mockResolvedValue([
        makeClaim({ id: 'c1' }),
      ]);
      claimEntityRepo.findByClaims.mockResolvedValue([makeClaimEntity()]);
      personRepo.findByIds.mockResolvedValue([makePerson()]);
      claimRepo.findByEntity.mockResolvedValue([]);

      await builder.build('fam1', 'evt-1', 'Ricardo said hello.');

      expect(personRepo.findAllActive).not.toHaveBeenCalled();
    });
  });
});
