import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RegistrarAgent } from './registrar';
import type {
  ScribeDomainModel,
  ImageReference,
} from '@sobremesa/shared-types';

// Mock repositories
const mockPersonRepo = {
  findBestMatch: vi.fn(),
  findOrCreate: vi.fn(),
  createNew: vi.fn(),
  updateAliases: vi.fn(),
  findById: vi.fn(),
  update: vi.fn(),
};

const mockPlaceRepo = {
  findOrCreate: vi.fn(),
  findExisting: vi.fn(),
};

const mockEventRepo = {
  createFromExtracted: vi.fn(),
  findOrCreate: vi.fn(),
  matchAndEnrich: vi.fn(),
};

const mockStoryRepo = {
  createFromExtracted: vi.fn(),
};

const mockClaimRepo = {
  findActiveBySubject: vi.fn(),
  findByEntity: vi.fn(),
  createFromExtracted: vi.fn(),
  addConflict: vi.fn(),
};

const mockRelationshipRepo = {
  findBetween: vi.fn(),
  findOrCreate: vi.fn(),
};

const mockEventLog = {
  log: vi.fn(),
};

const mockConversationEventRepo = {
  findById: vi.fn(),
};

const mockIdentityRepo = {
  findByProviderUserId: vi.fn(),
};

const mockImageRepo = {
  addConnectedPeople: vi.fn(),
  addContext: vi.fn(),
  findById: vi.fn(),
};

const mockClaimAnalysisRepo = {
  create: vi.fn(),
  createForClaim: vi.fn(),
  findByClaimIds: vi.fn(),
  update: vi.fn(),
};

const mockEntityMergeRepo = {
  create: vi.fn(),
  findByEntityId: vi.fn(),
};

const mockClaimEntityRepo = {
  link: vi.fn(),
  linkEntityToClaim: vi.fn(),
  findClaimsByEntity: vi.fn(),
};

const mockClaimRelationshipRepo = {
  create: vi.fn(),
  findByClaimId: vi.fn(),
};

const mockStoryPeopleRepo = {
  addPerson: vi.fn(),
};

const mockStoryPlacesRepo = {
  addPlace: vi.fn(),
};

const mockStoryEventsRepo = {
  addEvent: vi.fn(),
};

const mockStoryConversationEventsRepo = {
  addConversationEvent: vi.fn(),
};

const mockEventPeopleRepo = {
  addPerson: vi.fn(),
  createMany: vi.fn(),
  findByEvent: vi.fn(),
};

const mockEventPlacesRepo = {
  addPlace: vi.fn(),
};

const mockLlmQueueRepo = {
  enqueue: vi.fn(),
  dequeue: vi.fn(),
};

const mockLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('RegistrarAgent - Image Reference Handling', () => {
  let registrar: RegistrarAgent;

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementations
    mockConversationEventRepo.findById.mockResolvedValue({
      id: 'event-123',
      source: 'telegram',
      actorExternalId: 'ext-test-user',
      actorDisplayName: 'Test User',
      actorUsername: 'testuser',
    });
    mockIdentityRepo.findByProviderUserId.mockResolvedValue({
      id: 'identity-test-user',
    });

    mockPersonRepo.findBestMatch.mockResolvedValue(null);
    mockPersonRepo.findOrCreate.mockImplementation(
      async (_familyId, person) => ({
        id: `person-${person.name.toLowerCase().replace(/\s+/g, '-')}`,
        ...person,
      }),
    );
    mockPersonRepo.createNew.mockImplementation(async (_familyId, person) => ({
      id: `person-${person.name.toLowerCase().replace(/\s+/g, '-')}`,
      ...person,
    }));

    mockPlaceRepo.findOrCreate.mockImplementation(async (_familyId, place) => ({
      id: `place-${place.name.toLowerCase().replace(/\s+/g, '-')}`,
      ...place,
      createdAt: new Date(Date.now() - 10000), // Not newly created
    }));

    mockClaimRepo.findActiveBySubject.mockResolvedValue([]);
    mockClaimRepo.createFromExtracted.mockImplementation(
      async (_familyId, claim) => ({
        id: `claim-${Date.now()}`,
        ...claim,
      }),
    );

    mockEventLog.log.mockResolvedValue(undefined);
    mockImageRepo.addConnectedPeople.mockResolvedValue({});
    mockImageRepo.addContext.mockResolvedValue({});

    registrar = new RegistrarAgent({
      personRepo: mockPersonRepo as any,
      placeRepo: mockPlaceRepo as any,
      eventRepo: mockEventRepo as any,
      storyRepo: mockStoryRepo as any,
      claimRepo: mockClaimRepo as any,
      claimAnalysisRepo: mockClaimAnalysisRepo as any,
      relationshipRepo: mockRelationshipRepo as any,
      eventLog: mockEventLog as any,
      conversationEventRepo: mockConversationEventRepo as any,
      identityRepo: mockIdentityRepo as any,
      imageRepo: mockImageRepo as any,
      entityMergeRepo: mockEntityMergeRepo as any,
      claimEntityRepo: mockClaimEntityRepo as any,
      claimRelationshipRepo: mockClaimRelationshipRepo as any,
      storyPeopleRepo: mockStoryPeopleRepo as any,
      storyPlacesRepo: mockStoryPlacesRepo as any,
      storyEventsRepo: mockStoryEventsRepo as any,
      eventPeopleRepo: mockEventPeopleRepo as any,
      eventPlacesRepo: mockEventPlacesRepo as any,
      llmQueueRepo: mockLlmQueueRepo as any,
      logger: mockLogger as any,
    });
  });

  const createBaseDomainModel = (
    imageReferences: ImageReference[] = [],
  ): ScribeDomainModel => ({
    conversationEventId: 'event-123',
    familyId: 'family-abc',
    processedAt: new Date(),
    people: [],
    places: [],
    events: [],
    relationships: [],
    claims: [],
    imageReferences,
    detectedLanguage: 'en',
  });

  it('skips a reference whose imageId is not a real image id, without a warning', async () => {
    // WhatsApp imports carry "image omitted" placeholders, not images, so
    // Scribe sees no ids to cite and sometimes invents one.
    const domainModel = createBaseDomainModel([
      {
        imageId: 'image_omitted_latest',
        referenceType: 'provides_context',
        contextProvided: 'Family photo at the beach',
        confidence: 'medium',
      },
    ]);

    await registrar.persist(domainModel, 'family-abc');

    expect(mockImageRepo.addContext).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      'Failed to process image reference',
    );
  });

  describe('identifies_people references', () => {
    it('should add connected people to image when people are in personIdMap', async () => {
      const domainModel = createBaseDomainModel([
        {
          imageId: '00000000-0000-4000-8000-000000000002',
          referenceType: 'identifies_people',
          peopleIdentified: ['Maria', 'Roberto'],
          confidence: 'high',
        },
      ]);

      // Add people to the domain model so they get added to personIdMap
      domainModel.people = [
        { name: 'Maria', aliases: [], confidence: 'high' },
        { name: 'Roberto', aliases: [], confidence: 'high' },
      ];

      await registrar.persist(domainModel, 'family-abc');

      expect(mockImageRepo.addConnectedPeople).toHaveBeenCalledWith(
        'family-abc',
        '00000000-0000-4000-8000-000000000002',
        expect.arrayContaining(['person-maria', 'person-roberto']),
      );
    });

    it('should resolve people via findBestMatch when not in personIdMap', async () => {
      mockPersonRepo.findBestMatch.mockResolvedValueOnce({
        person: { id: 'existing-maria-id', name: 'Maria García' },
        confidence: 0.9,
        matchReason: 'exact_name',
      });

      const domainModel = createBaseDomainModel([
        {
          imageId: '00000000-0000-4000-8000-000000000002',
          referenceType: 'identifies_people',
          peopleIdentified: ['Maria'],
          confidence: 'high',
        },
      ]);

      await registrar.persist(domainModel, 'family-abc');

      expect(mockPersonRepo.findBestMatch).toHaveBeenCalledWith(
        'family-abc',
        'Maria',
        [],
      );
      expect(mockImageRepo.addConnectedPeople).toHaveBeenCalledWith(
        'family-abc',
        '00000000-0000-4000-8000-000000000002',
        ['existing-maria-id'],
      );
    });

    it('should not add connected people if none are resolved', async () => {
      mockPersonRepo.findBestMatch.mockResolvedValue(null);

      const domainModel = createBaseDomainModel([
        {
          imageId: '00000000-0000-4000-8000-000000000002',
          referenceType: 'identifies_people',
          peopleIdentified: ['Unknown Person'],
          confidence: 'low',
        },
      ]);

      await registrar.persist(domainModel, 'family-abc');

      expect(mockImageRepo.addConnectedPeople).not.toHaveBeenCalled();
    });

    it('should skip if peopleIdentified is empty', async () => {
      const domainModel = createBaseDomainModel([
        {
          imageId: '00000000-0000-4000-8000-000000000002',
          referenceType: 'identifies_people',
          peopleIdentified: [],
          confidence: 'medium',
        },
      ]);

      await registrar.persist(domainModel, 'family-abc');

      expect(mockImageRepo.addConnectedPeople).not.toHaveBeenCalled();
    });

    it('should skip if peopleIdentified is undefined', async () => {
      const domainModel = createBaseDomainModel([
        {
          imageId: '00000000-0000-4000-8000-000000000002',
          referenceType: 'identifies_people',
          peopleIdentified: [],
          confidence: 'medium',
        },
      ]);

      await registrar.persist(domainModel, 'family-abc');

      expect(mockImageRepo.addConnectedPeople).not.toHaveBeenCalled();
    });
  });

  describe('provides_context references', () => {
    it('should add context to image', async () => {
      const domainModel = createBaseDomainModel([
        {
          imageId: '00000000-0000-4000-8000-000000000005',
          referenceType: 'provides_context',
          peopleIdentified: [],
          contextProvided:
            'This was taken at the wedding in Buenos Aires, 1962',
          confidence: 'high',
        },
      ]);

      await registrar.persist(domainModel, 'family-abc');

      expect(mockImageRepo.addContext).toHaveBeenCalledWith(
        'family-abc',
        '00000000-0000-4000-8000-000000000005',
        'This was taken at the wedding in Buenos Aires, 1962',
        'event-123',
      );
    });

    it('should skip if contextProvided is empty', async () => {
      const domainModel = createBaseDomainModel([
        {
          imageId: '00000000-0000-4000-8000-000000000005',
          referenceType: 'provides_context',
          peopleIdentified: [],
          contextProvided: '',
          confidence: 'medium',
        },
      ]);

      await registrar.persist(domainModel, 'family-abc');

      expect(mockImageRepo.addContext).not.toHaveBeenCalled();
    });

    it('should skip if contextProvided is undefined', async () => {
      const domainModel = createBaseDomainModel([
        {
          imageId: '00000000-0000-4000-8000-000000000005',
          referenceType: 'provides_context',
          peopleIdentified: [],
          confidence: 'medium',
        },
      ]);

      await registrar.persist(domainModel, 'family-abc');

      expect(mockImageRepo.addContext).not.toHaveBeenCalled();
    });
  });

  describe('describes references', () => {
    it('should add context to image for describes reference type', async () => {
      const domainModel = createBaseDomainModel([
        {
          imageId: '00000000-0000-4000-8000-000000000006',
          referenceType: 'describes',
          peopleIdentified: [],
          contextProvided:
            'A family gathering with about 20 people at a long table',
          confidence: 'medium',
        },
      ]);

      await registrar.persist(domainModel, 'family-abc');

      expect(mockImageRepo.addContext).toHaveBeenCalledWith(
        'family-abc',
        '00000000-0000-4000-8000-000000000006',
        'A family gathering with about 20 people at a long table',
        'event-123',
      );
    });
  });

  describe('asks_about references', () => {
    it('should increment counter but not call any image methods for asks_about', async () => {
      const domainModel = createBaseDomainModel([
        {
          imageId: '00000000-0000-4000-8000-000000000007',
          referenceType: 'asks_about',
          peopleIdentified: [],
          confidence: 'medium',
        },
      ]);

      await registrar.persist(domainModel, 'family-abc');

      // asks_about should still count as processed but not modify the image
      expect(mockImageRepo.addConnectedPeople).not.toHaveBeenCalled();
      expect(mockImageRepo.addContext).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should continue processing other references if one fails', async () => {
      mockImageRepo.addConnectedPeople.mockRejectedValueOnce(
        new Error('Image not found'),
      );

      // Mock for the second call to succeed
      mockImageRepo.addContext.mockResolvedValueOnce({});

      const domainModel = createBaseDomainModel([
        {
          imageId: '00000000-0000-4000-8000-000000000008',
          referenceType: 'identifies_people',
          peopleIdentified: ['Maria'],
          confidence: 'high',
        },
        {
          imageId: '00000000-0000-4000-8000-000000000009',
          referenceType: 'provides_context',
          peopleIdentified: [],
          contextProvided: 'Some context',
          confidence: 'high',
        },
      ]);

      // Add person so it gets resolved
      domainModel.people = [{ name: 'Maria', aliases: [], confidence: 'high' }];

      // Should not throw
      await registrar.persist(domainModel, 'family-abc');

      // First call should fail
      expect(mockImageRepo.addConnectedPeople).toHaveBeenCalled();
      // Second reference should still be processed
      expect(mockImageRepo.addContext).toHaveBeenCalledWith(
        'family-abc',
        '00000000-0000-4000-8000-000000000009',
        'Some context',
        'event-123',
      );
      // Warning should be logged
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          imageId: '00000000-0000-4000-8000-000000000008',
          referenceType: 'identifies_people',
        }),
        'Failed to process image reference',
      );
    });
  });

  describe('combined references', () => {
    it('should handle multiple references for the same image', async () => {
      const domainModel = createBaseDomainModel([
        {
          imageId: '00000000-0000-4000-8000-000000000002',
          referenceType: 'identifies_people',
          peopleIdentified: ['Grandma Maria'],
          confidence: 'high',
        },
        {
          imageId: '00000000-0000-4000-8000-000000000002',
          referenceType: 'provides_context',
          peopleIdentified: [],
          contextProvided: 'Wedding photo from 1962',
          confidence: 'high',
        },
      ]);

      domainModel.people = [
        { name: 'Grandma Maria', aliases: [], confidence: 'high' },
      ];

      await registrar.persist(domainModel, 'family-abc');

      expect(mockImageRepo.addConnectedPeople).toHaveBeenCalledWith(
        'family-abc',
        '00000000-0000-4000-8000-000000000002',
        ['person-grandma-maria'],
      );
      expect(mockImageRepo.addContext).toHaveBeenCalledWith(
        'family-abc',
        '00000000-0000-4000-8000-000000000002',
        'Wedding photo from 1962',
        'event-123',
      );
    });

    it('should handle reference with both people and context', async () => {
      const domainModel = createBaseDomainModel([
        {
          imageId: '00000000-0000-4000-8000-000000000002',
          referenceType: 'identifies_people',
          peopleIdentified: ['Uncle Roberto'],
          contextProvided: 'This is at his birthday party',
          confidence: 'high',
        },
      ]);

      domainModel.people = [
        { name: 'Uncle Roberto', aliases: [], confidence: 'high' },
      ];

      await registrar.persist(domainModel, 'family-abc');

      // identifies_people should add people but not context
      expect(mockImageRepo.addConnectedPeople).toHaveBeenCalled();
      // Context is only added for provides_context or describes reference types
      expect(mockImageRepo.addContext).not.toHaveBeenCalled();
    });
  });

  describe('imageReferencesProcessed counter', () => {
    it('should increment counter for each successfully processed reference', async () => {
      const domainModel = createBaseDomainModel([
        {
          imageId: '00000000-0000-4000-8000-000000000001',
          referenceType: 'provides_context',
          peopleIdentified: [],
          contextProvided: 'Context 1',
          confidence: 'high',
        },
        {
          imageId: '00000000-0000-4000-8000-000000000003',
          referenceType: 'provides_context',
          peopleIdentified: [],
          contextProvided: 'Context 2',
          confidence: 'high',
        },
        {
          imageId: '00000000-0000-4000-8000-000000000004',
          referenceType: 'asks_about',
          peopleIdentified: [],
          confidence: 'medium',
        },
      ]);

      await registrar.persist(domainModel, 'family-abc');

      // Check that event log received the correct count
      expect(mockEventLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          eventData: expect.objectContaining({
            imageReferencesProcessed: 3,
          }),
        }),
      );
    });
  });

  describe('empty imageReferences', () => {
    it('should handle undefined imageReferences gracefully', async () => {
      const domainModel = createBaseDomainModel();
      // Explicitly set to undefined
      (domainModel as any).imageReferences = undefined;

      await registrar.persist(domainModel, 'family-abc');

      expect(mockImageRepo.addConnectedPeople).not.toHaveBeenCalled();
      expect(mockImageRepo.addContext).not.toHaveBeenCalled();
    });

    it('should handle empty imageReferences array', async () => {
      const domainModel = createBaseDomainModel([]);

      await registrar.persist(domainModel, 'family-abc');

      expect(mockImageRepo.addConnectedPeople).not.toHaveBeenCalled();
      expect(mockImageRepo.addContext).not.toHaveBeenCalled();
    });
  });
});

describe('RegistrarAgent - Event Deduplication', () => {
  let registrar: RegistrarAgent;

  beforeEach(() => {
    vi.clearAllMocks();

    mockConversationEventRepo.findById.mockResolvedValue({
      id: 'event-123',
      source: 'telegram',
      actorExternalId: 'ext-test-user',
      actorDisplayName: 'Test User',
      actorUsername: 'testuser',
    });
    mockIdentityRepo.findByProviderUserId.mockResolvedValue({
      id: 'identity-test-user',
    });

    mockPersonRepo.findBestMatch.mockResolvedValue(null);
    mockPersonRepo.findOrCreate.mockImplementation(
      async (_familyId, person) => ({
        id: `person-${person.name.toLowerCase().replace(/\\s+/g, '-')}`,
        ...person,
      }),
    );

    mockPlaceRepo.findOrCreate.mockImplementation(async (_familyId, place) => ({
      id: `place-${place.name.toLowerCase().replace(/\\s+/g, '-')}`,
      ...place,
      createdAt: new Date(Date.now() - 10000),
    }));

    mockEventLog.log.mockResolvedValue(undefined);
    mockEventPeopleRepo.createMany.mockResolvedValue([]);
    mockEventPeopleRepo.findByEvent.mockResolvedValue([]);

    registrar = new RegistrarAgent({
      personRepo: mockPersonRepo as any,
      placeRepo: mockPlaceRepo as any,
      eventRepo: mockEventRepo as any,
      storyRepo: mockStoryRepo as any,
      claimRepo: mockClaimRepo as any,
      claimAnalysisRepo: mockClaimAnalysisRepo as any,
      relationshipRepo: mockRelationshipRepo as any,
      eventLog: mockEventLog as any,
      conversationEventRepo: mockConversationEventRepo as any,
      identityRepo: mockIdentityRepo as any,
      imageRepo: mockImageRepo as any,
      entityMergeRepo: mockEntityMergeRepo as any,
      claimEntityRepo: mockClaimEntityRepo as any,
      claimRelationshipRepo: mockClaimRelationshipRepo as any,
      storyPeopleRepo: mockStoryPeopleRepo as any,
      storyPlacesRepo: mockStoryPlacesRepo as any,
      storyEventsRepo: mockStoryEventsRepo as any,
      eventPeopleRepo: mockEventPeopleRepo as any,
      eventPlacesRepo: mockEventPlacesRepo as any,
      llmQueueRepo: mockLlmQueueRepo as any,
      logger: mockLogger as any,
    });
  });

  const createEventDomainModel = (): ScribeDomainModel => ({
    conversationEventId: 'event-123',
    familyId: 'family-abc',
    processedAt: new Date(),
    people: [
      { name: 'Maria', aliases: [], confidence: 'high' },
      { name: 'Roberto', aliases: [], confidence: 'high' },
    ],
    places: [],
    events: [
      {
        title: 'Leaving Cuba',
        eventType: 'migration',
        dateYear: 1959,
        peopleInvolved: ['Maria', 'Roberto'],
        confidence: 'high',
      },
    ],
    relationships: [],
    claims: [],
    imageReferences: [],
    detectedLanguage: 'en',
  });

  it('should link all people when creating a new event', async () => {
    mockEventRepo.findOrCreate.mockResolvedValue({
      event: { id: 'new-event-1', title: 'Leaving Cuba' },
      created: true,
      enrichedFields: [],
    });

    const domainModel = createEventDomainModel();
    await registrar.persist(domainModel, 'family-abc');

    expect(mockEventRepo.findOrCreate).toHaveBeenCalledWith(
      'family-abc',
      expect.objectContaining({ title: 'Leaving Cuba' }),
      expect.arrayContaining(['person-maria', 'person-roberto']),
      undefined,
      'event-123',
      'Test User',
      expect.any(String),
    );

    expect(mockEventPeopleRepo.createMany).toHaveBeenCalledWith([
      {
        familyId: 'family-abc',
        eventId: 'new-event-1',
        personId: 'person-maria',
      },
      {
        familyId: 'family-abc',
        eventId: 'new-event-1',
        personId: 'person-roberto',
      },
    ]);
  });

  it('should link additional people to existing event when duplicate found', async () => {
    // Event already exists with Maria linked
    mockEventRepo.findOrCreate.mockResolvedValue({
      event: { id: 'existing-event-1', title: 'Leaving Cuba' },
      created: false,
      enrichedFields: [],
    });

    // Maria is already linked to the event
    mockEventPeopleRepo.findByEvent.mockResolvedValue([
      {
        familyId: 'family-abc',
        eventId: 'existing-event-1',
        personId: 'person-maria',
      },
    ]);

    const domainModel = createEventDomainModel();
    await registrar.persist(domainModel, 'family-abc');

    // Should only link Roberto (Maria already linked)
    expect(mockEventPeopleRepo.createMany).toHaveBeenCalledWith([
      {
        familyId: 'family-abc',
        eventId: 'existing-event-1',
        personId: 'person-roberto',
      },
    ]);

    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        eventTitle: 'Leaving Cuba',
        existingEventId: 'existing-event-1',
        newPeopleLinked: 1,
      }),
      'Linked additional people to existing event',
    );
  });

  it('should not create duplicate links when all people already linked', async () => {
    mockEventRepo.findOrCreate.mockResolvedValue({
      event: { id: 'existing-event-1', title: 'Leaving Cuba' },
      created: false,
      enrichedFields: [],
    });

    // Both Maria and Roberto are already linked
    mockEventPeopleRepo.findByEvent.mockResolvedValue([
      {
        familyId: 'family-abc',
        eventId: 'existing-event-1',
        personId: 'person-maria',
      },
      {
        familyId: 'family-abc',
        eventId: 'existing-event-1',
        personId: 'person-roberto',
      },
    ]);

    const domainModel = createEventDomainModel();
    await registrar.persist(domainModel, 'family-abc');

    // createMany should not be called since no new people to link
    expect(mockEventPeopleRepo.createMany).not.toHaveBeenCalled();

    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        eventTitle: 'Leaving Cuba',
        existingEventId: 'existing-event-1',
      }),
      'Skipping duplicate event (all people already linked)',
    );
  });

  it('should handle event with no people involved', async () => {
    mockEventRepo.findOrCreate.mockResolvedValue({
      event: { id: 'new-event-1', title: 'Hurricane' },
      created: true,
      enrichedFields: [],
    });

    const domainModel = createEventDomainModel();
    domainModel.events = [
      {
        title: 'Hurricane',
        eventType: 'natural_disaster',
        dateYear: 1960,
        peopleInvolved: [],
        confidence: 'medium',
      },
    ];

    await registrar.persist(domainModel, 'family-abc');

    // Should not call createMany when no people involved
    expect(mockEventPeopleRepo.createMany).not.toHaveBeenCalled();
  });
});

describe('RegistrarAgent - Claim Subject Resolution', () => {
  let registrar: RegistrarAgent;

  beforeEach(() => {
    vi.clearAllMocks();

    mockConversationEventRepo.findById.mockResolvedValue({
      id: 'event-123',
      source: 'telegram',
      actorExternalId: 'ext-test-user',
      actorDisplayName: 'Test User',
      actorUsername: 'testuser',
    });
    mockIdentityRepo.findByProviderUserId.mockResolvedValue({
      id: 'identity-test-user',
    });

    mockPersonRepo.findBestMatch.mockResolvedValue(null);
    mockPersonRepo.createNew.mockImplementation(async (_familyId, person) => ({
      id: `person-${person.name.toLowerCase().replace(/\s+/g, '-')}`,
      ...person,
    }));

    mockPlaceRepo.findOrCreate.mockImplementation(async (_familyId, place) => ({
      id: `place-${place.name.toLowerCase().replace(/\s+/g, '-')}`,
      ...place,
      createdAt: new Date(Date.now() - 10000),
    }));

    mockClaimRepo.findActiveBySubject.mockResolvedValue([]);
    mockClaimRepo.findByEntity.mockResolvedValue([]);
    mockClaimRepo.createFromExtracted.mockImplementation(
      async (_familyId, claim) => ({
        id: 'claim-1',
        ...claim,
      }),
    );
    mockClaimAnalysisRepo.createForClaim.mockResolvedValue({});
    mockClaimAnalysisRepo.findByClaimIds.mockResolvedValue([]);
    mockClaimEntityRepo.link.mockResolvedValue({});
    mockClaimRelationshipRepo.create.mockResolvedValue({});
    mockEventRepo.findOrCreate.mockImplementation(async (_familyId, event) => ({
      event: {
        id: `event-${event.title.toLowerCase().replace(/\s+/g, '-')}`,
        title: event.title,
      },
      created: true,
      enrichedFields: [],
    }));
    mockEventPeopleRepo.createMany.mockResolvedValue([]);
    mockEventLog.log.mockResolvedValue(undefined);

    registrar = new RegistrarAgent({
      personRepo: mockPersonRepo as any,
      placeRepo: mockPlaceRepo as any,
      eventRepo: mockEventRepo as any,
      storyRepo: mockStoryRepo as any,
      claimRepo: mockClaimRepo as any,
      claimAnalysisRepo: mockClaimAnalysisRepo as any,
      relationshipRepo: mockRelationshipRepo as any,
      eventLog: mockEventLog as any,
      conversationEventRepo: mockConversationEventRepo as any,
      identityRepo: mockIdentityRepo as any,
      imageRepo: mockImageRepo as any,
      entityMergeRepo: mockEntityMergeRepo as any,
      claimEntityRepo: mockClaimEntityRepo as any,
      claimRelationshipRepo: mockClaimRelationshipRepo as any,
      storyPeopleRepo: mockStoryPeopleRepo as any,
      storyPlacesRepo: mockStoryPlacesRepo as any,
      storyEventsRepo: mockStoryEventsRepo as any,
      eventPeopleRepo: mockEventPeopleRepo as any,
      eventPlacesRepo: mockEventPlacesRepo as any,
      llmQueueRepo: mockLlmQueueRepo as any,
      logger: mockLogger as any,
    });
  });

  it('uses referencedPeople to resolve a multilingual possessive subject (#10)', async () => {
    const domainModel: ScribeDomainModel = {
      conversationEventId: 'event-123',
      familyId: 'family-abc',
      processedAt: new Date(),
      people: [{ name: 'María', aliases: [], confidence: 'medium' }],
      places: [],
      events: [],
      relationships: [],
      claims: [
        {
          claimType: 'detail',
          subject: 'la boda de María',
          claimValue: 'fue en Buenos Aires',
          confidence: 'medium',
          claimedBySource: 'direct',
          referencedPeople: ['María'],
        },
      ],
      imageReferences: [],
      detectedLanguage: 'es',
    };

    await registrar.persist(domainModel, 'family-abc');

    expect(mockClaimEntityRepo.link).toHaveBeenCalledWith(
      'family-abc',
      'claim-1',
      'person-maría',
      'person',
      { role: 'subject' },
    );
    expect(mockClaimEntityRepo.link).not.toHaveBeenCalledWith(
      'family-abc',
      'claim-1',
      'person-maría',
      'person',
      { role: 'related' },
    );
  });

  it('does not double-link a referencedPeople entity also mentioned in the claim text (regression)', async () => {
    // Carlos is linked via referencedPeople AND his name also appears in
    // claimValue, so the later "mentioned in claim text" scan must not
    // re-link him — that duplicate insert violates the claim_entities unique
    // constraint and used to fail the whole persist.
    const domainModel: ScribeDomainModel = {
      conversationEventId: 'event-123',
      familyId: 'family-abc',
      processedAt: new Date(),
      people: [{ name: 'Carlos', aliases: [], confidence: 'high' }],
      places: [],
      events: [],
      relationships: [],
      claims: [
        {
          claimType: 'detail',
          subject: 'The wedding',
          claimValue: 'Carlos walked her down the aisle and cried',
          confidence: 'high',
          claimedBySource: 'direct',
          referencedPeople: ['Carlos'],
        },
      ],
      imageReferences: [],
      detectedLanguage: 'en',
    };

    await registrar.persist(domainModel, 'family-abc');

    const carlosRelatedLinks = mockClaimEntityRepo.link.mock.calls.filter(
      ([, , entityId, entityType, opts]: [
        string,
        string,
        string,
        string,
        { role: string },
      ]) =>
        entityId === 'person-carlos' &&
        entityType === 'person' &&
        opts.role === 'related',
    );
    expect(carlosRelatedLinks).toHaveLength(1);
  });

  it('uses a multilingual event title as the event subject (#10)', async () => {
    const domainModel: ScribeDomainModel = {
      conversationEventId: 'event-123',
      familyId: 'family-abc',
      processedAt: new Date(),
      people: [],
      places: [],
      events: [
        {
          title: 'boda de María',
          eventType: 'marriage',
          peopleInvolved: [],
          confidence: 'medium',
        },
      ],
      relationships: [],
      claims: [
        {
          claimType: 'location',
          subject: 'la boda de María',
          claimValue: 'Buenos Aires',
          confidence: 'medium',
          claimedBySource: 'direct',
        },
      ],
      imageReferences: [],
      detectedLanguage: 'es',
    };

    await registrar.persist(domainModel, 'family-abc');

    expect(mockClaimEntityRepo.link).toHaveBeenCalledWith(
      'family-abc',
      'claim-1',
      'event-boda-de-maría',
      'event',
      { role: 'subject' },
    );
  });
});

describe('RegistrarAgent - Speaker-Relative Aliases (F4)', () => {
  let registrar: RegistrarAgent;

  beforeEach(() => {
    vi.clearAllMocks();

    mockConversationEventRepo.findById.mockResolvedValue({
      id: 'event-123',
      source: 'telegram',
      actorExternalId: 'ext-test-user',
      actorDisplayName: 'Test User',
      actorUsername: 'testuser',
    });
    mockIdentityRepo.findByProviderUserId.mockResolvedValue({
      id: 'identity-test-user',
    });

    mockPersonRepo.findBestMatch.mockResolvedValue(null);
    mockPersonRepo.createNew.mockImplementation(async (_familyId, person) => ({
      id: `person-${person.name.toLowerCase().replace(/\s+/g, '-')}`,
      ...person,
    }));

    mockPlaceRepo.findOrCreate.mockImplementation(async (_familyId, place) => ({
      id: `place-${place.name.toLowerCase().replace(/\s+/g, '-')}`,
      ...place,
      createdAt: new Date(Date.now() - 10000),
    }));

    mockClaimRepo.findActiveBySubject.mockResolvedValue([]);
    mockClaimRepo.findByEntity.mockResolvedValue([]);
    mockClaimRepo.createFromExtracted.mockImplementation(
      async (_familyId, claim) => ({
        id: 'claim-1',
        ...claim,
      }),
    );
    mockClaimAnalysisRepo.createForClaim.mockResolvedValue({});
    mockClaimAnalysisRepo.findByClaimIds.mockResolvedValue([]);
    mockClaimEntityRepo.link.mockResolvedValue({});
    mockClaimRelationshipRepo.create.mockResolvedValue({});
    mockEventPeopleRepo.createMany.mockResolvedValue([]);
    mockEventLog.log.mockResolvedValue(undefined);

    registrar = new RegistrarAgent({
      personRepo: mockPersonRepo as any,
      placeRepo: mockPlaceRepo as any,
      eventRepo: mockEventRepo as any,
      storyRepo: mockStoryRepo as any,
      claimRepo: mockClaimRepo as any,
      claimAnalysisRepo: mockClaimAnalysisRepo as any,
      relationshipRepo: mockRelationshipRepo as any,
      eventLog: mockEventLog as any,
      conversationEventRepo: mockConversationEventRepo as any,
      identityRepo: mockIdentityRepo as any,
      imageRepo: mockImageRepo as any,
      entityMergeRepo: mockEntityMergeRepo as any,
      claimEntityRepo: mockClaimEntityRepo as any,
      claimRelationshipRepo: mockClaimRelationshipRepo as any,
      storyPeopleRepo: mockStoryPeopleRepo as any,
      storyPlacesRepo: mockStoryPlacesRepo as any,
      storyEventsRepo: mockStoryEventsRepo as any,
      eventPeopleRepo: mockEventPeopleRepo as any,
      eventPlacesRepo: mockEventPlacesRepo as any,
      llmQueueRepo: mockLlmQueueRepo as any,
      logger: mockLogger as any,
    });
  });

  it('creates a new person with the speaker-relative alias dropped', async () => {
    const domainModel: ScribeDomainModel = {
      conversationEventId: 'event-123',
      familyId: 'family-abc',
      processedAt: new Date(),
      people: [
        {
          name: 'Gerie Najlis',
          aliases: ['Geraldine', 'mi tía'],
          confidence: 'high',
        },
      ],
      places: [],
      events: [],
      relationships: [],
      claims: [],
      imageReferences: [],
      detectedLanguage: 'es',
    };

    await registrar.persist(domainModel, 'family-abc');

    expect(mockPersonRepo.createNew).toHaveBeenCalledWith(
      'family-abc',
      expect.objectContaining({ name: 'Gerie Najlis', aliases: ['Geraldine'] }),
      'event-123',
      expect.anything(),
      expect.anything(),
    );
  });

  it('still resolves a same-message claim subject that is a speaker-relative term', async () => {
    const domainModel: ScribeDomainModel = {
      conversationEventId: 'event-123',
      familyId: 'family-abc',
      processedAt: new Date(),
      people: [
        { name: 'Gerie Najlis', aliases: ['mi tía'], confidence: 'high' },
      ],
      places: [],
      events: [],
      relationships: [],
      claims: [
        {
          claimType: 'detail',
          subject: 'mi tía',
          claimValue: 'le encanta cocinar',
          confidence: 'high',
          claimedBySource: 'direct',
        },
      ],
      imageReferences: [],
      detectedLanguage: 'es',
    };

    await registrar.persist(domainModel, 'family-abc');

    expect(mockClaimEntityRepo.link).toHaveBeenCalledWith(
      'family-abc',
      'claim-1',
      'person-gerie-najlis',
      'person',
      { role: 'subject' },
    );
  });

  it('does not offer a speaker-relative term as a suggested alias for a matched person', async () => {
    mockPersonRepo.findBestMatch.mockResolvedValueOnce({
      person: {
        id: 'existing-1',
        name: 'Gerie Najlis',
        aliases: ['Geraldine'],
      },
      confidence: 'high',
      matchReason: 'exact match',
    });
    mockPersonRepo.findById.mockResolvedValueOnce({
      id: 'existing-1',
      name: 'Gerie Najlis',
      aliases: ['Geraldine'],
    });
    mockPersonRepo.updateAliases.mockResolvedValue({});

    const domainModel: ScribeDomainModel = {
      conversationEventId: 'event-123',
      familyId: 'family-abc',
      processedAt: new Date(),
      people: [
        {
          name: 'Gerie Najlis',
          aliases: ['Geraldine', 'mi tía'],
          confidence: 'high',
        },
      ],
      places: [],
      events: [],
      relationships: [],
      claims: [],
      imageReferences: [],
      detectedLanguage: 'es',
    };

    await registrar.persist(domainModel, 'family-abc');

    expect(mockPersonRepo.updateAliases).not.toHaveBeenCalled();
  });
});

describe('RegistrarAgent - Claim Attribution Stamping (provenance-integrity-plan.md #2)', () => {
  let registrar: RegistrarAgent;

  beforeEach(() => {
    vi.clearAllMocks();

    mockConversationEventRepo.findById.mockResolvedValue({
      id: 'event-123',
      source: 'telegram',
      actorExternalId: 'ext-minnie',
      actorDisplayName: 'Minnie',
      actorUsername: 'minnie',
    });
    mockIdentityRepo.findByProviderUserId.mockResolvedValue({
      id: 'identity-minnie',
    });

    mockPersonRepo.findBestMatch.mockResolvedValue(null);
    mockPersonRepo.createNew.mockImplementation(async (_familyId, person) => ({
      id: `person-${person.name.toLowerCase().replace(/\s+/g, '-')}`,
      ...person,
    }));

    mockPlaceRepo.findOrCreate.mockImplementation(async (_familyId, place) => ({
      id: `place-${place.name.toLowerCase().replace(/\s+/g, '-')}`,
      ...place,
      createdAt: new Date(Date.now() - 10000),
    }));

    mockClaimRepo.findActiveBySubject.mockResolvedValue([]);
    mockClaimRepo.findByEntity.mockResolvedValue([]);
    mockClaimRepo.createFromExtracted.mockImplementation(
      async (_familyId, claim) => ({
        id: 'claim-1',
        ...claim,
      }),
    );
    mockClaimAnalysisRepo.createForClaim.mockResolvedValue({});
    mockClaimAnalysisRepo.findByClaimIds.mockResolvedValue([]);
    mockClaimEntityRepo.link.mockResolvedValue({});
    mockClaimRelationshipRepo.create.mockResolvedValue({});
    mockEventLog.log.mockResolvedValue(undefined);

    registrar = new RegistrarAgent({
      personRepo: mockPersonRepo as any,
      placeRepo: mockPlaceRepo as any,
      eventRepo: mockEventRepo as any,
      storyRepo: mockStoryRepo as any,
      claimRepo: mockClaimRepo as any,
      claimAnalysisRepo: mockClaimAnalysisRepo as any,
      relationshipRepo: mockRelationshipRepo as any,
      eventLog: mockEventLog as any,
      conversationEventRepo: mockConversationEventRepo as any,
      identityRepo: mockIdentityRepo as any,
      imageRepo: mockImageRepo as any,
      entityMergeRepo: mockEntityMergeRepo as any,
      claimEntityRepo: mockClaimEntityRepo as any,
      claimRelationshipRepo: mockClaimRelationshipRepo as any,
      storyPeopleRepo: mockStoryPeopleRepo as any,
      storyPlacesRepo: mockStoryPlacesRepo as any,
      storyEventsRepo: mockStoryEventsRepo as any,
      eventPeopleRepo: mockEventPeopleRepo as any,
      eventPlacesRepo: mockEventPlacesRepo as any,
      llmQueueRepo: mockLlmQueueRepo as any,
      logger: mockLogger as any,
    });
  });

  const claimDomainModel = (
    claim: ScribeDomainModel['claims'][number],
  ): ScribeDomainModel => ({
    conversationEventId: 'event-123',
    familyId: 'family-abc',
    processedAt: new Date(),
    people: [],
    places: [],
    events: [],
    relationships: [],
    claims: [claim],
    imageReferences: [],
    detectedLanguage: 'en',
  });

  it('stamps claimed_by from the deterministic sender, never from extraction (context-bleed trap)', async () => {
    const domainModel = claimDomainModel({
      claimType: 'date',
      subject: 'Grandpa Ernesto',
      claimValue: '1939',
      confidence: 'high',
      claimedBySource: 'direct',
    });

    await registrar.persist(domainModel, 'family-abc');

    expect(mockClaimRepo.createFromExtracted).toHaveBeenCalledWith(
      'family-abc',
      expect.objectContaining({ subject: 'Grandpa Ernesto' }),
      'event-123',
      'Minnie',
      'identity-minnie',
      expect.any(String),
    );
  });

  it('leaves claimedByIdentityId undefined when the identity does not resolve (e.g. WhatsApp import)', async () => {
    mockIdentityRepo.findByProviderUserId.mockResolvedValue(null);

    const domainModel = claimDomainModel({
      claimType: 'detail',
      subject: 'Rosa',
      claimValue: 'loved fishing',
      confidence: 'medium',
      claimedBySource: 'direct',
    });

    await registrar.persist(domainModel, 'family-abc');

    expect(mockClaimRepo.createFromExtracted).toHaveBeenCalledWith(
      'family-abc',
      expect.objectContaining({ subject: 'Rosa' }),
      'event-123',
      'Minnie',
      undefined,
      expect.any(String),
    );
  });

  it('does not resolve an identity when there are no claims to stamp', async () => {
    const domainModel: ScribeDomainModel = {
      conversationEventId: 'event-123',
      familyId: 'family-abc',
      processedAt: new Date(),
      people: [{ name: 'Rosa', aliases: [], confidence: 'high' }],
      places: [],
      events: [],
      relationships: [],
      claims: [],
      imageReferences: [],
      detectedLanguage: 'en',
    };

    await registrar.persist(domainModel, 'family-abc');

    expect(mockIdentityRepo.findByProviderUserId).not.toHaveBeenCalled();
  });

  it('passes attributedTo verbatim through to the persisted claim for hearsay', async () => {
    const domainModel = claimDomainModel({
      claimType: 'date',
      subject: 'Grandpa Ernesto',
      claimValue: '1939',
      confidence: 'medium',
      claimedBySource: 'hearsay',
      attributedTo: 'Mom',
    });

    await registrar.persist(domainModel, 'family-abc');

    expect(mockClaimRepo.createFromExtracted).toHaveBeenCalledWith(
      'family-abc',
      expect.objectContaining({
        attributedTo: 'Mom',
        claimedBySource: 'hearsay',
      }),
      'event-123',
      'Minnie',
      'identity-minnie',
      expect.any(String),
    );
  });
});

describe('RegistrarAgent - Evidence Grounding (provenance-integrity-plan.md #3)', () => {
  let registrar: RegistrarAgent;

  const CURRENT_CONTENT = 'Grandpa Ernesto was born in Oaxaca in 1943.';
  const CONTEXT_CONTENTS = [
    'Rosa moved from Oaxaca to Guadalajara in 1965.',
    'We should plan the reunion soon.',
  ];

  beforeEach(() => {
    vi.clearAllMocks();

    mockConversationEventRepo.findById.mockResolvedValue({
      id: 'event-123',
      source: 'telegram',
      actorExternalId: 'ext-minnie',
      actorDisplayName: 'Minnie',
      actorUsername: 'minnie',
      contentOriginal: CURRENT_CONTENT,
    });
    mockIdentityRepo.findByProviderUserId.mockResolvedValue({
      id: 'identity-minnie',
    });

    mockPersonRepo.findBestMatch.mockResolvedValue(null);
    mockPersonRepo.createNew.mockImplementation(async (_familyId, person) => ({
      id: `person-${person.name.toLowerCase().replace(/\s+/g, '-')}`,
      ...person,
    }));

    mockClaimRepo.findActiveBySubject.mockResolvedValue([]);
    mockClaimRepo.findByEntity.mockResolvedValue([]);
    mockClaimRepo.createFromExtracted.mockImplementation(
      async (_familyId, claim) => ({
        id: 'claim-1',
        ...claim,
      }),
    );
    mockClaimAnalysisRepo.createForClaim.mockResolvedValue({});
    mockClaimAnalysisRepo.findByClaimIds.mockResolvedValue([]);
    mockClaimEntityRepo.link.mockResolvedValue({});
    mockClaimRelationshipRepo.create.mockResolvedValue({});
    mockEventLog.log.mockResolvedValue(undefined);

    registrar = new RegistrarAgent({
      personRepo: mockPersonRepo as any,
      placeRepo: mockPlaceRepo as any,
      eventRepo: mockEventRepo as any,
      storyRepo: mockStoryRepo as any,
      claimRepo: mockClaimRepo as any,
      claimAnalysisRepo: mockClaimAnalysisRepo as any,
      relationshipRepo: mockRelationshipRepo as any,
      eventLog: mockEventLog as any,
      conversationEventRepo: mockConversationEventRepo as any,
      identityRepo: mockIdentityRepo as any,
      imageRepo: mockImageRepo as any,
      entityMergeRepo: mockEntityMergeRepo as any,
      claimEntityRepo: mockClaimEntityRepo as any,
      claimRelationshipRepo: mockClaimRelationshipRepo as any,
      storyPeopleRepo: mockStoryPeopleRepo as any,
      storyPlacesRepo: mockStoryPlacesRepo as any,
      storyEventsRepo: mockStoryEventsRepo as any,
      eventPeopleRepo: mockEventPeopleRepo as any,
      eventPlacesRepo: mockEventPlacesRepo as any,
      llmQueueRepo: mockLlmQueueRepo as any,
      logger: mockLogger as any,
    });
  });

  const claimDomainModel = (
    claim: ScribeDomainModel['claims'][number],
  ): ScribeDomainModel => ({
    conversationEventId: 'event-123',
    familyId: 'family-abc',
    processedAt: new Date(),
    people: [],
    places: [],
    events: [],
    relationships: [],
    claims: [claim],
    imageReferences: [],
    detectedLanguage: 'en',
  });

  it('persists a claim whose evidence is grounded in the current message, unflagged', async () => {
    const domainModel = claimDomainModel({
      claimType: 'date',
      subject: "Grandpa Ernesto's birth",
      claimValue: '1943',
      evidence: 'born in Oaxaca in 1943',
      confidence: 'high',
      claimedBySource: 'direct',
    });

    await registrar.persist(
      domainModel,
      'family-abc',
      undefined,
      CONTEXT_CONTENTS,
    );

    expect(mockClaimRepo.createFromExtracted).toHaveBeenCalledTimes(1);
    const analysis = mockClaimAnalysisRepo.createForClaim.mock.calls[0][2];
    expect(analysis.strengthFactors.grounding).toBeUndefined();
  });

  it('rejects a context-bleed claim: nothing persisted, claim_rejected logged', async () => {
    const domainModel = claimDomainModel({
      claimType: 'detail',
      subject: "Rosa's move",
      claimValue: 'Guadalajara',
      // Verbatim from a context message, absent from the current message.
      evidence: 'moved from Oaxaca to Guadalajara in 1965',
      confidence: 'medium',
      claimedBySource: 'direct',
    });

    await registrar.persist(
      domainModel,
      'family-abc',
      undefined,
      CONTEXT_CONTENTS,
    );

    expect(mockClaimRepo.createFromExtracted).not.toHaveBeenCalled();
    expect(mockClaimAnalysisRepo.createForClaim).not.toHaveBeenCalled();
    expect(mockEventLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'claim_rejected',
        severity: 'warning',
        eventData: expect.objectContaining({ reason: 'context_bleed' }),
      }),
    );
  });

  it('keeps an unmatched-evidence claim but flags grounding=failed in the analysis', async () => {
    const domainModel = claimDomainModel({
      claimType: 'detail',
      subject: 'Grandpa Ernesto',
      claimValue: 'loved mangoes',
      evidence: 'he really loved mangoes', // paraphrase; matches nothing
      confidence: 'medium',
      claimedBySource: 'direct',
    });

    await registrar.persist(
      domainModel,
      'family-abc',
      undefined,
      CONTEXT_CONTENTS,
    );

    expect(mockClaimRepo.createFromExtracted).toHaveBeenCalledTimes(1);
    const analysis = mockClaimAnalysisRepo.createForClaim.mock.calls[0][2];
    expect(analysis.strengthFactors.grounding).toBe('failed');
  });

  it('never rejects when the source event has no content, even if evidence matches context', async () => {
    mockConversationEventRepo.findById.mockResolvedValue({
      id: 'event-123',
      source: 'telegram',
      actorExternalId: 'ext-minnie',
      actorDisplayName: 'Minnie',
      actorUsername: 'minnie',
      contentOriginal: undefined, // e.g. media without caption
    });

    const domainModel = claimDomainModel({
      claimType: 'detail',
      subject: "Rosa's move",
      claimValue: 'Guadalajara',
      evidence: 'moved from Oaxaca to Guadalajara in 1965',
      confidence: 'medium',
      claimedBySource: 'direct',
    });

    await registrar.persist(
      domainModel,
      'family-abc',
      undefined,
      CONTEXT_CONTENTS,
    );

    // Bleed cannot be proven without a current message: flag, never reject.
    expect(mockClaimRepo.createFromExtracted).toHaveBeenCalledTimes(1);
    const analysis = mockClaimAnalysisRepo.createForClaim.mock.calls[0][2];
    expect(analysis.strengthFactors.grounding).toBe('failed');
  });

  it('never rejects without contextContents: out-of-message evidence is flagged, kept', async () => {
    const domainModel = claimDomainModel({
      claimType: 'detail',
      subject: "Rosa's move",
      claimValue: 'Guadalajara',
      evidence: 'moved from Oaxaca to Guadalajara in 1965',
      confidence: 'medium',
      claimedBySource: 'direct',
    });

    // No contextContents passed (e.g. a legacy caller).
    await registrar.persist(domainModel, 'family-abc');

    expect(mockClaimRepo.createFromExtracted).toHaveBeenCalledTimes(1);
    const analysis = mockClaimAnalysisRepo.createForClaim.mock.calls[0][2];
    expect(analysis.strengthFactors.grounding).toBe('failed');
  });
});

describe('RegistrarAgent - Story persistence on retry (hardening F)', () => {
  const storyRepo = { findOrCreate: vi.fn() };
  const storyPeopleRepo = { createMany: vi.fn() };
  const storyPlacesRepo = { createMany: vi.fn() };
  const storyEventsRepo = { createMany: vi.fn() };
  let registrar: RegistrarAgent;

  beforeEach(() => {
    vi.clearAllMocks();

    mockConversationEventRepo.findById.mockResolvedValue({
      id: 'event-123',
      source: 'telegram',
      actorExternalId: 'ext-test-user',
      actorDisplayName: 'Test User',
      actorUsername: 'testuser',
    });
    mockPersonRepo.findBestMatch.mockResolvedValue(null);
    mockPersonRepo.createNew.mockImplementation(async (_familyId, person) => ({
      id: `person-${person.name.toLowerCase()}`,
      ...person,
    }));
    mockPlaceRepo.findOrCreate.mockImplementation(async (_familyId, place) => ({
      id: `place-${place.name.toLowerCase()}`,
      ...place,
      createdAt: new Date(Date.now() - 10000),
    }));
    mockEventLog.log.mockResolvedValue(undefined);
    storyPeopleRepo.createMany.mockResolvedValue([]);
    storyPlacesRepo.createMany.mockResolvedValue([]);
    storyEventsRepo.createMany.mockResolvedValue([]);

    registrar = new RegistrarAgent({
      personRepo: mockPersonRepo as any,
      placeRepo: mockPlaceRepo as any,
      eventRepo: mockEventRepo as any,
      storyRepo: storyRepo as any,
      claimRepo: mockClaimRepo as any,
      claimAnalysisRepo: mockClaimAnalysisRepo as any,
      relationshipRepo: mockRelationshipRepo as any,
      eventLog: mockEventLog as any,
      conversationEventRepo: mockConversationEventRepo as any,
      identityRepo: mockIdentityRepo as any,
      imageRepo: mockImageRepo as any,
      entityMergeRepo: mockEntityMergeRepo as any,
      claimEntityRepo: mockClaimEntityRepo as any,
      claimRelationshipRepo: mockClaimRelationshipRepo as any,
      storyPeopleRepo: storyPeopleRepo as any,
      storyPlacesRepo: storyPlacesRepo as any,
      storyEventsRepo: storyEventsRepo as any,
      eventPeopleRepo: mockEventPeopleRepo as any,
      eventPlacesRepo: mockEventPlacesRepo as any,
      llmQueueRepo: mockLlmQueueRepo as any,
      logger: mockLogger as any,
    });
  });

  const storyModel = (): ScribeDomainModel =>
    ({
      conversationEventId: 'event-123',
      familyId: 'family-abc',
      processedAt: new Date(),
      people: [{ name: 'Maria', aliases: [], confidence: 'high' }],
      places: [{ name: 'Havana', confidence: 'high' }],
      events: [],
      relationships: [],
      claims: [],
      imageReferences: [],
      detectedLanguage: 'en',
      story: {
        title: 'The drive to Havana',
        content: 'Maria remembered the long drive to Havana.',
        themes: ['travel'],
      },
    }) as unknown as ScribeDomainModel;

  const persistedEvent = () =>
    mockEventLog.log.mock.calls
      .map((call) => call[0])
      .find((entry) => entry.eventType === 'event_processed');

  it('counts a created story and links its people and places', async () => {
    storyRepo.findOrCreate.mockResolvedValue({
      storyId: 'story-1',
      outcome: 'created',
    });

    await registrar.persist(storyModel(), 'family-abc');

    expect(storyRepo.findOrCreate).toHaveBeenCalledWith(
      'family-abc',
      expect.objectContaining({ title: 'The drive to Havana' }),
      ['person-maria'],
      'event-123',
      'en',
      'Test User',
      expect.any(String),
    );
    expect(storyPeopleRepo.createMany).toHaveBeenCalledWith([
      { familyId: 'family-abc', storyId: 'story-1', personId: 'person-maria' },
    ]);
    expect(storyPlacesRepo.createMany).toHaveBeenCalledWith([
      { familyId: 'family-abc', storyId: 'story-1', placeId: 'place-havana' },
    ]);
    expect(persistedEvent().eventData).toMatchObject({
      storiesCreated: 1,
      storiesUpdated: 0,
    });
  });

  it('counts an append as an update', async () => {
    storyRepo.findOrCreate.mockResolvedValue({
      storyId: 'story-1',
      outcome: 'appended',
    });

    await registrar.persist(storyModel(), 'family-abc');

    expect(persistedEvent().eventData).toMatchObject({
      storiesCreated: 0,
      storiesUpdated: 1,
    });
  });

  it('on a retry the contribution is not counted again, but entity links are re-written', async () => {
    storyRepo.findOrCreate.mockResolvedValue({
      storyId: 'story-1',
      outcome: 'already_applied',
    });

    await registrar.persist(storyModel(), 'family-abc');

    expect(persistedEvent().eventData).toMatchObject({
      storiesCreated: 0,
      storiesUpdated: 0,
    });
    // The earlier attempt may have crashed before linking: links are
    // idempotent upserts, so they are written again in full.
    expect(storyPeopleRepo.createMany).toHaveBeenCalledWith([
      { familyId: 'family-abc', storyId: 'story-1', personId: 'person-maria' },
    ]);
    expect(storyPlacesRepo.createMany).toHaveBeenCalledWith([
      { familyId: 'family-abc', storyId: 'story-1', placeId: 'place-havana' },
    ]);
  });

  it('a link failure after the story commit fails the persist so the queue retries', async () => {
    storyRepo.findOrCreate.mockResolvedValue({
      storyId: 'story-1',
      outcome: 'created',
    });
    storyPeopleRepo.createMany.mockRejectedValueOnce(new Error('link down'));

    await expect(registrar.persist(storyModel(), 'family-abc')).rejects.toThrow(
      'link down',
    );
  });
});

describe('RegistrarAgent - from_context entities (provenance-integrity-plan.md #4)', () => {
  const storyRepo = { findOrCreate: vi.fn() };
  let registrar: RegistrarAgent;

  const EXISTING_PERSON = {
    id: 'person-rosa',
    name: 'Rosa Hernandez',
    aliases: [],
    birthYear: undefined,
    deathYear: undefined,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockConversationEventRepo.findById.mockResolvedValue({
      id: 'event-123',
      source: 'telegram',
      actorExternalId: 'ext-minnie',
      actorDisplayName: 'Minnie',
      actorUsername: 'minnie',
    });
    mockPersonRepo.findBestMatch.mockResolvedValue(null);
    mockPersonRepo.createNew.mockImplementation(async (_familyId, person) => ({
      id: `person-${person.name.toLowerCase().replace(/\s+/g, '-')}`,
      ...person,
    }));
    mockPersonRepo.findById.mockResolvedValue(EXISTING_PERSON);
    mockPersonRepo.update.mockResolvedValue(EXISTING_PERSON);
    mockPlaceRepo.findOrCreate.mockImplementation(async (_familyId, place) => ({
      id: `place-${place.name.toLowerCase()}`,
      ...place,
      createdAt: new Date(Date.now() - 10000),
    }));
    mockPlaceRepo.findExisting.mockResolvedValue(null);
    mockEventRepo.matchAndEnrich.mockResolvedValue(null);
    mockEventRepo.findOrCreate.mockImplementation(async (_familyId, event) => ({
      event: { id: `event-${event.title.toLowerCase()}`, title: event.title },
      created: true,
      enrichedFields: [],
    }));
    mockEventPeopleRepo.createMany.mockResolvedValue([]);
    mockEventPeopleRepo.findByEvent.mockResolvedValue([]);
    mockEventLog.log.mockResolvedValue(undefined);

    registrar = new RegistrarAgent({
      personRepo: mockPersonRepo as any,
      placeRepo: mockPlaceRepo as any,
      eventRepo: mockEventRepo as any,
      storyRepo: storyRepo as any,
      claimRepo: mockClaimRepo as any,
      claimAnalysisRepo: mockClaimAnalysisRepo as any,
      relationshipRepo: mockRelationshipRepo as any,
      eventLog: mockEventLog as any,
      conversationEventRepo: mockConversationEventRepo as any,
      identityRepo: mockIdentityRepo as any,
      imageRepo: mockImageRepo as any,
      entityMergeRepo: mockEntityMergeRepo as any,
      claimEntityRepo: mockClaimEntityRepo as any,
      claimRelationshipRepo: mockClaimRelationshipRepo as any,
      storyPeopleRepo: mockStoryPeopleRepo as any,
      storyPlacesRepo: mockStoryPlacesRepo as any,
      storyEventsRepo: mockStoryEventsRepo as any,
      eventPeopleRepo: mockEventPeopleRepo as any,
      eventPlacesRepo: mockEventPlacesRepo as any,
      llmQueueRepo: mockLlmQueueRepo as any,
      logger: mockLogger as any,
    });
  });

  const model = (overrides: Partial<ScribeDomainModel>): ScribeDomainModel => ({
    conversationEventId: 'event-123',
    familyId: 'family-abc',
    processedAt: new Date(),
    people: [],
    places: [],
    events: [],
    relationships: [],
    claims: [],
    imageReferences: [],
    detectedLanguage: 'en',
    ...overrides,
  });

  const enrichedLogs = () =>
    mockEventLog.log.mock.calls
      .map((call) => call[0])
      .filter((entry) => entry.eventType === 'entity_enriched');

  describe('people', () => {
    it('drops an unmatched from_context person: no record, no claim anchor', async () => {
      await registrar.persist(
        model({
          people: [
            {
              name: 'Phantom Person',
              aliases: [],
              fromContext: true,
              confidence: 'medium',
            },
          ],
        }),
        'family-abc',
      );

      expect(mockPersonRepo.createNew).not.toHaveBeenCalled();
      expect(enrichedLogs()).toEqual([]);
    });

    it('still creates an unmatched person that is not from_context', async () => {
      await registrar.persist(
        model({
          people: [
            { name: 'Phantom Person', aliases: [], confidence: 'medium' },
          ],
        }),
        'family-abc',
      );

      expect(mockPersonRepo.createNew).toHaveBeenCalledTimes(1);
    });

    it('enriches a matched from_context person and audits it with the source message', async () => {
      mockPersonRepo.findBestMatch.mockResolvedValue({
        person: EXISTING_PERSON,
        confidence: 0.95,
        matchReason: 'exact',
      });

      await registrar.persist(
        model({
          people: [
            {
              name: 'Rosa Hernandez',
              aliases: [],
              birthYear: 1931,
              fromContext: true,
              confidence: 'medium',
            },
          ],
        }),
        'family-abc',
      );

      expect(mockPersonRepo.createNew).not.toHaveBeenCalled();
      expect(mockPersonRepo.update).toHaveBeenCalledWith(
        'family-abc',
        'person-rosa',
        { birthYear: 1931 },
      );
      expect(enrichedLogs()).toEqual([
        expect.objectContaining({
          familyId: 'family-abc',
          conversationEventId: 'event-123',
          eventData: {
            entityType: 'person',
            entityId: 'person-rosa',
            fields: ['birthYear'],
            fromContext: true,
          },
        }),
      ]);
    });

    it('audits bio enrichment of an ordinary matched person too, flagged not from_context', async () => {
      mockPersonRepo.findBestMatch.mockResolvedValue({
        person: EXISTING_PERSON,
        confidence: 0.95,
        matchReason: 'exact',
      });

      await registrar.persist(
        model({
          people: [
            {
              name: 'Rosa Hernandez',
              aliases: [],
              deathYear: 2001,
              confidence: 'medium',
            },
          ],
        }),
        'family-abc',
      );

      expect(enrichedLogs()).toEqual([
        expect.objectContaining({
          eventData: expect.objectContaining({
            fields: ['deathYear'],
            fromContext: false,
          }),
        }),
      ]);
    });

    it('writes no audit entry when a match changes nothing', async () => {
      mockPersonRepo.findBestMatch.mockResolvedValue({
        person: EXISTING_PERSON,
        confidence: 0.95,
        matchReason: 'exact',
      });

      await registrar.persist(
        model({
          people: [
            {
              name: 'Rosa Hernandez',
              aliases: [],
              fromContext: true,
              confidence: 'medium',
            },
          ],
        }),
        'family-abc',
      );

      expect(mockPersonRepo.update).not.toHaveBeenCalled();
      expect(enrichedLogs()).toEqual([]);
    });
  });

  describe('places', () => {
    it('drops an unmatched from_context place', async () => {
      await registrar.persist(
        model({
          places: [
            { name: 'Atlantis', fromContext: true, confidence: 'medium' },
          ],
        }),
        'family-abc',
      );

      expect(mockPlaceRepo.findExisting).toHaveBeenCalledTimes(1);
      expect(mockPlaceRepo.findOrCreate).not.toHaveBeenCalled();
    });

    it('resolves a matched from_context place without creating', async () => {
      mockPlaceRepo.findExisting.mockResolvedValue({
        id: 'place-oaxaca',
        name: 'Oaxaca',
      });
      mockEventRepo.findOrCreate.mockImplementation(async () => ({
        event: { id: 'event-new', title: 'Wedding' },
        created: true,
        enrichedFields: [],
      }));

      await registrar.persist(
        model({
          places: [{ name: 'Oaxaca', fromContext: true, confidence: 'medium' }],
          events: [
            {
              title: 'Wedding',
              peopleInvolved: [],
              placeName: 'Oaxaca',
              confidence: 'medium',
            },
          ],
        }),
        'family-abc',
      );

      expect(mockPlaceRepo.findOrCreate).not.toHaveBeenCalled();
      expect(mockEventRepo.findOrCreate).toHaveBeenCalledWith(
        'family-abc',
        expect.anything(),
        [],
        'place-oaxaca',
        'event-123',
        'Minnie',
        expect.any(String),
      );
    });
  });

  describe('events', () => {
    const contextEvent = {
      title: 'Leaving Cuba',
      dateYear: 1959,
      peopleInvolved: [],
      fromContext: true,
      confidence: 'medium' as const,
    };

    it('drops an unmatched from_context event: never created', async () => {
      await registrar.persist(model({ events: [contextEvent] }), 'family-abc');

      expect(mockEventRepo.matchAndEnrich).toHaveBeenCalledTimes(1);
      expect(mockEventRepo.findOrCreate).not.toHaveBeenCalled();
      expect(mockEventRepo.createFromExtracted).not.toHaveBeenCalled();
      expect(enrichedLogs()).toEqual([]);
    });

    it('enriches a matched from_context event and audits the changed fields', async () => {
      mockEventRepo.matchAndEnrich.mockResolvedValue({
        event: { id: 'event-existing', title: 'Leaving Cuba' },
        enrichedFields: ['dateYear'],
      });

      await registrar.persist(model({ events: [contextEvent] }), 'family-abc');

      expect(mockEventRepo.findOrCreate).not.toHaveBeenCalled();
      expect(enrichedLogs()).toEqual([
        expect.objectContaining({
          conversationEventId: 'event-123',
          eventData: {
            entityType: 'event',
            entityId: 'event-existing',
            fields: ['dateYear'],
            fromContext: true,
          },
        }),
      ]);
    });

    it('audits enrichment reported by findOrCreate for an ordinary event', async () => {
      mockEventRepo.findOrCreate.mockResolvedValue({
        event: { id: 'event-existing', title: 'Leaving Cuba' },
        created: false,
        enrichedFields: ['placeId'],
      });

      await registrar.persist(
        model({ events: [{ ...contextEvent, fromContext: false }] }),
        'family-abc',
      );

      expect(enrichedLogs()).toEqual([
        expect.objectContaining({
          eventData: expect.objectContaining({
            entityType: 'event',
            fields: ['placeId'],
            fromContext: false,
          }),
        }),
      ]);
    });
  });

  describe('stories', () => {
    const story = {
      title: 'The crossing',
      content: 'They crossed at night.',
      themes: ['migration'],
    };

    it('drops a from_context story: nothing appended or created', async () => {
      await registrar.persist(
        model({ story: { ...story, fromContext: true } }),
        'family-abc',
      );

      expect(storyRepo.findOrCreate).not.toHaveBeenCalled();
    });

    it('audits an append to an existing story', async () => {
      storyRepo.findOrCreate.mockResolvedValue({
        storyId: 'story-1',
        outcome: 'appended',
      });
      mockStoryPeopleRepo.createMany = vi.fn();
      mockStoryPlacesRepo.createMany = vi.fn();
      mockStoryEventsRepo.createMany = vi.fn();

      await registrar.persist(model({ story }), 'family-abc');

      expect(enrichedLogs()).toEqual([
        expect.objectContaining({
          conversationEventId: 'event-123',
          eventData: {
            entityType: 'story',
            entityId: 'story-1',
            fields: ['content'],
            fromContext: false,
          },
        }),
      ]);
    });

    it('does not audit a newly created story', async () => {
      storyRepo.findOrCreate.mockResolvedValue({
        storyId: 'story-1',
        outcome: 'created',
      });

      await registrar.persist(model({ story }), 'family-abc');

      expect(enrichedLogs()).toEqual([]);
    });
  });
});
