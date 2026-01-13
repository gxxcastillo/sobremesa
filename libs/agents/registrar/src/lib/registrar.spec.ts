import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RegistrarAgent } from './registrar.js';
import type { ScribeDomainModel, ImageReference } from '@sobremesa/shared-types';
import { Confidence } from '@sobremesa/shared-types';

// Mock repositories
const mockPersonRepo = {
  findBestMatch: vi.fn(),
  findOrCreate: vi.fn(),
  updateAliases: vi.fn(),
};

const mockPlaceRepo = {
  findOrCreate: vi.fn(),
};

const mockEventRepo = {
  createFromExtracted: vi.fn(),
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
    mockPersonRepo.findOrCreate.mockImplementation(async (_familyId, person) => ({
      id: `person-${person.name.toLowerCase().replace(/\s+/g, '-')}`,
      ...person,
    }));

    mockPlaceRepo.findOrCreate.mockImplementation(async (_familyId, place) => ({
      id: `place-${place.name.toLowerCase().replace(/\s+/g, '-')}`,
      ...place,
      createdAt: new Date(Date.now() - 10000), // Not newly created
    }));

    mockClaimRepo.findActiveBySubject.mockResolvedValue([]);
    mockClaimRepo.createFromExtracted.mockImplementation(async (_familyId, claim) => ({
      id: `claim-${Date.now()}`,
      ...claim,
    }));

    mockEventLog.log.mockResolvedValue(undefined);
    mockImageRepo.addConnectedPeople.mockResolvedValue({});
    mockImageRepo.addContext.mockResolvedValue({});

    registrar = new RegistrarAgent({
      personRepo: mockPersonRepo as any,
      placeRepo: mockPlaceRepo as any,
      eventRepo: mockEventRepo as any,
      storyRepo: mockStoryRepo as any,
      claimRepo: mockClaimRepo as any,
      relationshipRepo: mockRelationshipRepo as any,
      questionRepo: mockQuestionRepo as any,
      eventLog: mockEventLog as any,
      conversationEventRepo: mockConversationEventRepo as any,
      imageRepo: mockImageRepo as any,
      logger: mockLogger as any,
    });
  });

  const createBaseDomainModel = (
    imageReferences: ImageReference[] = []
  ): ScribeDomainModel => ({
    sourceEventId: 'event-123',
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
          confidence: Confidence.HIGH,
        },
      ]);

      // Add people to the domain model so they get added to personIdMap
      domainModel.people = [
        { name: 'Maria', aliases: [], confidence: Confidence.HIGH },
        { name: 'Roberto', aliases: [], confidence: Confidence.HIGH },
      ];

      await registrar.persist(domainModel, 'family-abc');

      expect(mockImageRepo.addConnectedPeople).toHaveBeenCalledWith(
        'family-abc',
        'img-123',
        expect.arrayContaining(['person-maria', 'person-roberto'])
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
          confidence: Confidence.HIGH,
        },
      ]);

      await registrar.persist(domainModel, 'family-abc');

      expect(mockPersonRepo.findBestMatch).toHaveBeenCalledWith(
        'family-abc',
        'Maria',
        []
      );
      expect(mockImageRepo.addConnectedPeople).toHaveBeenCalledWith(
        'family-abc',
        'img-123',
        ['existing-maria-id']
      );
    });

    it('should not add connected people if none are resolved', async () => {
      mockPersonRepo.findBestMatch.mockResolvedValue(null);

      const domainModel = createBaseDomainModel([
        {
          imageId: 'img-123',
          referenceType: 'identifies_people',
          peopleIdentified: ['Unknown Person'],
          confidence: Confidence.LOW,
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
          confidence: Confidence.MEDIUM,
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
          confidence: Confidence.MEDIUM,
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
          contextProvided: 'This was taken at the wedding in Buenos Aires, 1962',
          confidence: Confidence.HIGH,
        },
      ]);

      await registrar.persist(domainModel, 'family-abc');

      expect(mockImageRepo.addContext).toHaveBeenCalledWith(
        'family-abc',
        'img-456',
        'This was taken at the wedding in Buenos Aires, 1962',
        'event-123'
      );
    });

    it('should skip if contextProvided is empty', async () => {
      const domainModel = createBaseDomainModel([
        {
          imageId: 'img-456',
          referenceType: 'provides_context',
          contextProvided: '',
          confidence: Confidence.MEDIUM,
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
          confidence: Confidence.MEDIUM,
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
          contextProvided: 'A family gathering with about 20 people at a long table',
          confidence: Confidence.MEDIUM,
        },
      ]);

      await registrar.persist(domainModel, 'family-abc');

      expect(mockImageRepo.addContext).toHaveBeenCalledWith(
        'family-abc',
        'img-789',
        'A family gathering with about 20 people at a long table',
        'event-123'
      );
    });
  });

  describe('asks_about references', () => {
    it('should increment counter but not call any image methods for asks_about', async () => {
      const domainModel = createBaseDomainModel([
        {
          imageId: 'img-999',
          referenceType: 'asks_about',
          confidence: Confidence.MEDIUM,
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
        new Error('Image not found')
      );

      // Mock for the second call to succeed
      mockImageRepo.addContext.mockResolvedValueOnce({});

      const domainModel = createBaseDomainModel([
        {
          imageId: 'img-bad',
          referenceType: 'identifies_people',
          peopleIdentified: ['Maria'],
          confidence: Confidence.HIGH,
        },
        {
          imageId: 'img-good',
          referenceType: 'provides_context',
          contextProvided: 'Some context',
          confidence: Confidence.HIGH,
        },
      ]);

      // Add person so it gets resolved
      domainModel.people = [
        { name: 'Maria', aliases: [], confidence: Confidence.HIGH },
      ];

      // Should not throw
      await registrar.persist(domainModel, 'family-abc');

      // First call should fail
      expect(mockImageRepo.addConnectedPeople).toHaveBeenCalled();
      // Second reference should still be processed
      expect(mockImageRepo.addContext).toHaveBeenCalledWith(
        'family-abc',
        'img-good',
        'Some context',
        'event-123'
      );
      // Warning should be logged
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          imageId: 'img-bad',
          referenceType: 'identifies_people',
        }),
        'Failed to process image reference'
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
          confidence: Confidence.HIGH,
        },
        {
          imageId: 'img-123',
          referenceType: 'provides_context',
          contextProvided: 'Wedding photo from 1962',
          confidence: Confidence.HIGH,
        },
      ]);

      domainModel.people = [
        { name: 'Grandma Maria', aliases: [], confidence: Confidence.HIGH },
      ];

      await registrar.persist(domainModel, 'family-abc');

      expect(mockImageRepo.addConnectedPeople).toHaveBeenCalledWith(
        'family-abc',
        'img-123',
        ['person-grandma-maria']
      );
      expect(mockImageRepo.addContext).toHaveBeenCalledWith(
        'family-abc',
        'img-123',
        'Wedding photo from 1962',
        'event-123'
      );
    });

    it('should handle reference with both people and context', async () => {
      const domainModel = createBaseDomainModel([
        {
          imageId: 'img-123',
          referenceType: 'identifies_people',
          peopleIdentified: ['Uncle Roberto'],
          contextProvided: 'This is at his birthday party',
          confidence: Confidence.HIGH,
        },
      ]);

      domainModel.people = [
        { name: 'Uncle Roberto', aliases: [], confidence: Confidence.HIGH },
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
          confidence: Confidence.HIGH,
        },
        {
          imageId: 'img-2',
          referenceType: 'provides_context',
          contextProvided: 'Context 2',
          confidence: Confidence.HIGH,
        },
        {
          imageId: 'img-3',
          referenceType: 'asks_about',
          confidence: Confidence.MEDIUM,
        },
      ]);

      await registrar.persist(domainModel, 'family-abc');

      // Check that event log received the correct count
      expect(mockEventLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          eventData: expect.objectContaining({
            imageReferencesProcessed: 3,
          }),
        })
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
