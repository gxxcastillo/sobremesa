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
};

const mockPlaceRepo = {
  findOrCreate: vi.fn(),
};

const mockEventRepo = {
  createFromExtracted: vi.fn(),
  findOrCreate: vi.fn(),
};

const mockStoryRepo = {
  createFromExtracted: vi.fn(),
};

const mockClaimRepo = {
  findActiveBySubject: vi.fn(),
  createFromExtracted: vi.fn(),
  addConflict: vi.fn(),
};

const mockRelationshipRepo = {
  findBetween: vi.fn(),
  findOrCreate: vi.fn(),
};

const mockQuestionRepo = {
  createFromGenerated: vi.fn(),
  markAnswered: vi.fn(),
};

const mockEventLog = {
  log: vi.fn(),
};

const mockConversationEventRepo = {
  findById: vi.fn(),
};

const mockImageRepo = {
  addConnectedPeople: vi.fn(),
  addContext: vi.fn(),
  findById: vi.fn(),
};

const mockClaimAnalysisRepo = {
  create: vi.fn(),
  update: vi.fn(),
};

const mockEntityMergeRepo = {
  create: vi.fn(),
  findByEntityId: vi.fn(),
};

const mockClaimEntityRepo = {
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
      actorDisplayName: 'Test User',
      actorUsername: 'testuser',
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
      imageRepo: mockImageRepo as any,
      entityMergeRepo: mockEntityMergeRepo as any,
      claimEntityRepo: mockClaimEntityRepo as any,
      claimRelationshipRepo: mockClaimRelationshipRepo as any,
      storyPeopleRepo: mockStoryPeopleRepo as any,
      storyPlacesRepo: mockStoryPlacesRepo as any,
      storyEventsRepo: mockStoryEventsRepo as any,
      storyConversationEventsRepo: mockStoryConversationEventsRepo as any,
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
    questions: [],
    answers: [],
    conflicts: [],
    imageReferences,
    detectedLanguage: 'en',
  });

  describe('identifies_people references', () => {
    it('should add connected people to image when people are in personIdMap', async () => {
      const domainModel = createBaseDomainModel([
        {
          imageId: 'img-123',
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
        'img-123',
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
          imageId: 'img-123',
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
        'img-123',
        ['existing-maria-id'],
      );
    });

    it('should not add connected people if none are resolved', async () => {
      mockPersonRepo.findBestMatch.mockResolvedValue(null);

      const domainModel = createBaseDomainModel([
        {
          imageId: 'img-123',
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
          imageId: 'img-123',
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
          imageId: 'img-123',
          referenceType: 'identifies_people',
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
          imageId: 'img-456',
          referenceType: 'provides_context',
          contextProvided:
            'This was taken at the wedding in Buenos Aires, 1962',
          confidence: 'high',
        },
      ]);

      await registrar.persist(domainModel, 'family-abc');

      expect(mockImageRepo.addContext).toHaveBeenCalledWith(
        'family-abc',
        'img-456',
        'This was taken at the wedding in Buenos Aires, 1962',
        'event-123',
      );
    });

    it('should skip if contextProvided is empty', async () => {
      const domainModel = createBaseDomainModel([
        {
          imageId: 'img-456',
          referenceType: 'provides_context',
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
          imageId: 'img-456',
          referenceType: 'provides_context',
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
          imageId: 'img-789',
          referenceType: 'describes',
          contextProvided:
            'A family gathering with about 20 people at a long table',
          confidence: 'medium',
        },
      ]);

      await registrar.persist(domainModel, 'family-abc');

      expect(mockImageRepo.addContext).toHaveBeenCalledWith(
        'family-abc',
        'img-789',
        'A family gathering with about 20 people at a long table',
        'event-123',
      );
    });
  });

  describe('asks_about references', () => {
    it('should increment counter but not call any image methods for asks_about', async () => {
      const domainModel = createBaseDomainModel([
        {
          imageId: 'img-999',
          referenceType: 'asks_about',
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
          imageId: 'img-bad',
          referenceType: 'identifies_people',
          peopleIdentified: ['Maria'],
          confidence: 'high',
        },
        {
          imageId: 'img-good',
          referenceType: 'provides_context',
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
        'img-good',
        'Some context',
        'event-123',
      );
      // Warning should be logged
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          imageId: 'img-bad',
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
          imageId: 'img-123',
          referenceType: 'identifies_people',
          peopleIdentified: ['Grandma Maria'],
          confidence: 'high',
        },
        {
          imageId: 'img-123',
          referenceType: 'provides_context',
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
        'img-123',
        ['person-grandma-maria'],
      );
      expect(mockImageRepo.addContext).toHaveBeenCalledWith(
        'family-abc',
        'img-123',
        'Wedding photo from 1962',
        'event-123',
      );
    });

    it('should handle reference with both people and context', async () => {
      const domainModel = createBaseDomainModel([
        {
          imageId: 'img-123',
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
          imageId: 'img-1',
          referenceType: 'provides_context',
          contextProvided: 'Context 1',
          confidence: 'high',
        },
        {
          imageId: 'img-2',
          referenceType: 'provides_context',
          contextProvided: 'Context 2',
          confidence: 'high',
        },
        {
          imageId: 'img-3',
          referenceType: 'asks_about',
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
      actorDisplayName: 'Test User',
      actorUsername: 'testuser',
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
      imageRepo: mockImageRepo as any,
      entityMergeRepo: mockEntityMergeRepo as any,
      claimEntityRepo: mockClaimEntityRepo as any,
      claimRelationshipRepo: mockClaimRelationshipRepo as any,
      storyPeopleRepo: mockStoryPeopleRepo as any,
      storyPlacesRepo: mockStoryPlacesRepo as any,
      storyEventsRepo: mockStoryEventsRepo as any,
      storyConversationEventsRepo: mockStoryConversationEventsRepo as any,
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
    questions: [],
    answers: [],
    conflicts: [],
    imageReferences: [],
    detectedLanguage: 'en',
  });

  it('should link all people when creating a new event', async () => {
    mockEventRepo.findOrCreate.mockResolvedValue({
      event: { id: 'new-event-1', title: 'Leaving Cuba' },
      created: true,
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
