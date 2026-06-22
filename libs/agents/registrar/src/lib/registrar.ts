import type { Person, ScribeDomainModel } from '@sobremesa/shared-types';
import {
  PersonRepository,
  PlaceRepository,
  TimelineEventRepository,
  StoryRepository,
  ClaimRepository,
  ClaimAnalysisRepository,
  RelationshipRepository,
  EventLogRepository,
  ConversationEventRepository,
  ImageRepository,
  EntityMergeRepository,
  ClaimEntityRepository,
  ClaimRelationshipRepository,
  StoryPeopleRepository,
  StoryPlacesRepository,
  StoryEventsRepository,
  StoryConversationEventsRepository,
  EventPeopleRepository,
  EventPlacesRepository,
  LlmEvaluationQueueRepository,
  type DatabaseClient,
} from '@sobremesa/database';
import { createLogger } from '@sobremesa/shared-utils';
import type pino from 'pino';
import {
  detectClaimConflict,
  findBestSubjectMatch,
  subjectsMatch,
} from './conflict-detector';
import { textMentionsName } from './name-match';
import {
  EntityMatcherService,
  ConflictDetectorService,
  MergeHandlerService,
  StrengthCalculatorService,
} from './services';

// Import registrar package version
import registrarPkg from '../../package.json' with { type: 'json' };

const REGISTRAR_VERSION = registrarPkg.version;

const ENTITY_MENTION_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'in',
  'at',
  'to',
  'for',
  'on',
  'and',
  'or',
  's',
  'el',
  'la',
  'los',
  'las',
  'de',
  'del',
  'da',
  'do',
  'dos',
  'das',
  'du',
  'des',
  'le',
  'les',
]);

function normalizeLookup(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .normalize('NFC')
    .trim();
}

function normalizedTokens(value: string): string[] {
  return normalizeLookup(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

function meaningfulTokens(value: string, minTokenLength = 2): string[] {
  return normalizedTokens(value).filter(
    (token) =>
      token.length >= minTokenLength && !ENTITY_MENTION_STOPWORDS.has(token),
  );
}

function textMentionsNameNormalized(
  text: string,
  name: string,
  minTokenLength = 2,
): boolean {
  const nameTokens = meaningfulTokens(name, minTokenLength);
  if (nameTokens.length === 0) return false;
  const textTokens = new Set(normalizedTokens(text));
  return nameTokens.every((token) => textTokens.has(token));
}

function getEntityIdByName(
  entityIdMap: Map<string, string>,
  name: string,
): string | undefined {
  const exact = entityIdMap.get(name);
  if (exact) return exact;

  const normalizedName = normalizeLookup(name);
  for (const [candidateName, entityId] of entityIdMap) {
    if (normalizeLookup(candidateName) === normalizedName) {
      return entityId;
    }
  }
  return undefined;
}

function resolveSingleReferencedEntity(
  subject: string,
  referencedNames: string[] | undefined,
  entityIdMap: Map<string, string>,
): string | undefined {
  const matchedIds = new Set<string>();
  for (const name of referencedNames || []) {
    const entityId = getEntityIdByName(entityIdMap, name);
    if (entityId && textMentionsNameNormalized(subject, name)) {
      matchedIds.add(entityId);
    }
  }
  return matchedIds.size === 1 ? [...matchedIds][0] : undefined;
}

function resolveSingleMentionedEntity(
  subject: string,
  entityIdMap: Map<string, string>,
): string | undefined {
  const matchedIds = new Set<string>();
  for (const [name, entityId] of entityIdMap) {
    if (textMentionsNameNormalized(subject, name)) {
      matchedIds.add(entityId);
    }
  }
  return matchedIds.size === 1 ? [...matchedIds][0] : undefined;
}

function resolveSingleMentionedEventTitle(
  subject: string,
  eventIdMap: Map<string, string>,
): string | undefined {
  const subjectTokens = new Set(meaningfulTokens(subject));
  const matchedIds = new Set<string>();

  for (const [title, eventId] of eventIdMap) {
    const titleTokens = meaningfulTokens(title);
    if (titleTokens.length < 2) continue;
    if (titleTokens.every((token) => subjectTokens.has(token))) {
      matchedIds.add(eventId);
    }
  }

  return matchedIds.size === 1 ? [...matchedIds][0] : undefined;
}

/**
 * Options for creating a RegistrarAgent.
 */
export interface RegistrarAgentOptions {
  /** Database client (required unless all repos provided) */
  dbClient?: DatabaseClient;
  /** Person repository */
  personRepo?: PersonRepository;
  /** Place repository */
  placeRepo?: PlaceRepository;
  /** Timeline event repository */
  eventRepo?: TimelineEventRepository;
  /** Story repository */
  storyRepo?: StoryRepository;
  /** Claim repository */
  claimRepo?: ClaimRepository;
  /** Claim analysis repository (Phase 1c) */
  claimAnalysisRepo?: ClaimAnalysisRepository;
  /** Relationship repository */
  relationshipRepo?: RelationshipRepository;
  /** Event log repository */
  eventLog?: EventLogRepository;
  /** Conversation event repository (for getting claimedBy info) */
  conversationEventRepo?: ConversationEventRepository;
  /** Image repository (for linking people to images) */
  imageRepo?: ImageRepository;
  /** Entity merge repository (Phase 1c) */
  entityMergeRepo?: EntityMergeRepository;
  /** Claim entity repository (Phase 1c) */
  claimEntityRepo?: ClaimEntityRepository;
  /** Claim relationship repository (Phase 1c) */
  claimRelationshipRepo?: ClaimRelationshipRepository;
  /** Story-people join table repository (Phase 2) */
  storyPeopleRepo?: StoryPeopleRepository;
  /** Story-places join table repository (Phase 2) */
  storyPlacesRepo?: StoryPlacesRepository;
  /** Story-events join table repository (Phase 2) */
  storyEventsRepo?: StoryEventsRepository;
  /** Story-conversation events join table repository (Phase 2) */
  storyConversationEventsRepo?: StoryConversationEventsRepository;
  /** Event-people join table repository (Phase 2) */
  eventPeopleRepo?: EventPeopleRepository;
  /** Event-places join table repository (Phase 2) */
  eventPlacesRepo?: EventPlacesRepository;
  /** LLM evaluation queue repository (Phase 1c) */
  llmQueueRepo?: LlmEvaluationQueueRepository;
  /** Logger instance */
  logger?: pino.Logger;
}

/**
 * Result of a Registrar persist operation.
 */
export interface PersistResult {
  peopleCreated: number;
  peopleUpdated: number;
  placesCreated: number;
  eventsCreated: number;
  storiesCreated: number;
  storiesUpdated: number;
  claimsCreated: number;
  conflictsDetected: number;
  relationshipsCreated: number;
  imageReferencesProcessed: number;
}

/**
 * The Registrar agent persists extracted data to the database.
 * It handles deduplication, conflict detection, and provenance tracking.
 * Refactored to use service layer (Phase 1c).
 */
export class RegistrarAgent {
  private personRepo: PersonRepository;
  private placeRepo: PlaceRepository;
  private eventRepo: TimelineEventRepository;
  private storyRepo: StoryRepository;
  private claimRepo: ClaimRepository;
  private claimAnalysisRepo: ClaimAnalysisRepository;
  private relationshipRepo: RelationshipRepository;
  private eventLog: EventLogRepository;
  private conversationEventRepo: ConversationEventRepository;
  private imageRepo: ImageRepository;
  private entityMergeRepo: EntityMergeRepository;
  private claimEntityRepo: ClaimEntityRepository;
  private claimRelationshipRepo: ClaimRelationshipRepository;
  private llmQueueRepo: LlmEvaluationQueueRepository;
  private logger: pino.Logger;

  // Phase 2: Join table repositories
  private storyPeopleRepo: StoryPeopleRepository;
  private storyPlacesRepo: StoryPlacesRepository;
  private storyEventsRepo: StoryEventsRepository;
  private storyConversationEventsRepo: StoryConversationEventsRepository;
  private eventPeopleRepo: EventPeopleRepository;
  private eventPlacesRepo: EventPlacesRepository;

  // Service layer
  private entityMatcherService: EntityMatcherService;
  private conflictDetectorService: ConflictDetectorService;
  private mergeHandlerService: MergeHandlerService;
  private strengthCalculatorService: StrengthCalculatorService;

  constructor(options: RegistrarAgentOptions = {}) {
    const { dbClient } = options;

    // Helper to get or create repository
    const getRepo = <T>(
      provided: T | undefined,
      create: (client: DatabaseClient) => T,
    ): T => {
      if (provided) return provided;
      if (!dbClient) {
        throw new Error(
          'RegistrarAgent requires either dbClient or all repository instances',
        );
      }
      return create(dbClient);
    };

    // Repositories
    this.personRepo = getRepo(
      options.personRepo,
      (c) => new PersonRepository(c),
    );
    this.placeRepo = getRepo(options.placeRepo, (c) => new PlaceRepository(c));
    this.eventRepo = getRepo(
      options.eventRepo,
      (c) => new TimelineEventRepository(c),
    );
    this.storyRepo = getRepo(options.storyRepo, (c) => new StoryRepository(c));
    this.claimRepo = getRepo(options.claimRepo, (c) => new ClaimRepository(c));
    this.claimAnalysisRepo = getRepo(
      options.claimAnalysisRepo,
      (c) => new ClaimAnalysisRepository(c),
    );
    this.relationshipRepo = getRepo(
      options.relationshipRepo,
      (c) => new RelationshipRepository(c),
    );
    this.eventLog = getRepo(options.eventLog, (c) => new EventLogRepository(c));
    this.conversationEventRepo = getRepo(
      options.conversationEventRepo,
      (c) => new ConversationEventRepository(c),
    );
    this.imageRepo = getRepo(options.imageRepo, (c) => new ImageRepository(c));
    this.entityMergeRepo = getRepo(
      options.entityMergeRepo,
      (c) => new EntityMergeRepository(c),
    );
    this.claimEntityRepo = getRepo(
      options.claimEntityRepo,
      (c) => new ClaimEntityRepository(c),
    );
    this.claimRelationshipRepo = getRepo(
      options.claimRelationshipRepo,
      (c) => new ClaimRelationshipRepository(c),
    );
    this.llmQueueRepo = getRepo(
      options.llmQueueRepo,
      (c) => new LlmEvaluationQueueRepository(c),
    );
    this.logger = options.logger || createLogger({ name: 'registrar' });

    // Phase 2: Join table repositories
    this.storyPeopleRepo = getRepo(
      options.storyPeopleRepo,
      (c) => new StoryPeopleRepository(c),
    );
    this.storyPlacesRepo = getRepo(
      options.storyPlacesRepo,
      (c) => new StoryPlacesRepository(c),
    );
    this.storyEventsRepo = getRepo(
      options.storyEventsRepo,
      (c) => new StoryEventsRepository(c),
    );
    this.storyConversationEventsRepo = getRepo(
      options.storyConversationEventsRepo,
      (c) => new StoryConversationEventsRepository(c),
    );
    this.eventPeopleRepo = getRepo(
      options.eventPeopleRepo,
      (c) => new EventPeopleRepository(c),
    );
    // Note: EventPlacesRepository initialized for future use - events currently use single placeId field
    this.eventPlacesRepo = getRepo(
      options.eventPlacesRepo,
      (c) => new EventPlacesRepository(c),
    );
    void this.eventPlacesRepo; // Mark as intentionally unused for now

    // Services
    this.entityMatcherService = new EntityMatcherService(
      this.personRepo,
      this.placeRepo,
    );
    this.conflictDetectorService = new ConflictDetectorService(this.claimRepo);
    this.mergeHandlerService = new MergeHandlerService(
      this.entityMergeRepo,
      this.personRepo,
      this.placeRepo,
      this.eventRepo,
      this.storyRepo,
    );
    this.strengthCalculatorService = new StrengthCalculatorService();
  }

  /**
   * Persist a domain model to the database.
   * This is the RegistrarProcessor function for MessageProcessor.
   *
   * @param pipelineVersions - Versions of upstream agents (intern, scribe) for extraction tracking
   */
  async persist(
    domainModel: ScribeDomainModel,
    familyId: string,
    pipelineVersions?: { internVersion?: string; scribeVersion?: string },
  ): Promise<void> {
    this.logger.info(
      { familyId, conversationEventId: domainModel.conversationEventId },
      'Registrar persist started',
    );

    const result: PersistResult = {
      peopleCreated: 0,
      peopleUpdated: 0,
      placesCreated: 0,
      eventsCreated: 0,
      storiesCreated: 0,
      storiesUpdated: 0,
      claimsCreated: 0,
      conflictsDetected: 0,
      relationshipsCreated: 0,
      imageReferencesProcessed: 0,
    };

    const conversationEventId = domainModel.conversationEventId;

    // Build composite extraction version from all pipeline components
    const versionParts: string[] = [];
    if (pipelineVersions?.internVersion) {
      versionParts.push(`intern-v${pipelineVersions.internVersion}`);
    }
    if (pipelineVersions?.scribeVersion) {
      versionParts.push(`scribe-v${pipelineVersions.scribeVersion}`);
    }
    versionParts.push(`registrar-v${REGISTRAR_VERSION}`);
    const extractionVersion = versionParts.join('+');

    // Get the claimedBy from the source event
    const sourceEvent = await this.conversationEventRepo.findById(
      familyId,
      conversationEventId,
    );
    const claimedBy =
      sourceEvent?.actorDisplayName || sourceEvent?.actorUsername || 'Unknown';

    // Build maps for name -> ID resolution
    const personIdMap = new Map<string, string>();
    const placeIdMap = new Map<string, string>();

    try {
      // 1. Process People (using EntityMatcherService)
      for (const person of domainModel.people) {
        const matchResult = await this.entityMatcherService.matchPerson(
          familyId,
          person,
        );

        if (matchResult.matched && matchResult.existingEntityId) {
          const existingPerson = await this.personRepo.findById(
            familyId,
            matchResult.existingEntityId,
          );

          if (!existingPerson) {
            throw new Error(
              `Matched person ${matchResult.existingEntityId} not found`,
            );
          }

          this.logger.debug(
            {
              familyId,
              extractedName: person.name,
              matchedName: existingPerson.name,
              matchedId: existingPerson.id,
              confidence: matchResult.confidence,
              matchReason: matchResult.matchReason,
            },
            'Person matched to existing',
          );

          // Add suggested aliases
          let personUpdated = false;
          if (
            matchResult.suggestedAliases &&
            matchResult.suggestedAliases.length > 0
          ) {
            await this.personRepo.updateAliases(familyId, existingPerson.id, [
              ...existingPerson.aliases,
              ...matchResult.suggestedAliases,
            ]);
            personUpdated = true;

            this.logger.debug(
              {
                familyId,
                personId: existingPerson.id,
                newAliases: matchResult.suggestedAliases,
              },
              'Added aliases to existing person',
            );
          }

          // Enrich biographical data
          const bioEnrichments: Partial<Person> = {};
          if (!existingPerson.birthYear && person.birthYear)
            bioEnrichments.birthYear = person.birthYear;
          if (!existingPerson.deathYear && person.deathYear)
            bioEnrichments.deathYear = person.deathYear;

          if (Object.keys(bioEnrichments).length > 0) {
            await this.personRepo.update(
              familyId,
              existingPerson.id,
              bioEnrichments,
            );
            personUpdated = true;

            this.logger.debug(
              {
                familyId,
                personId: existingPerson.id,
                enrichments: bioEnrichments,
              },
              'Enriched existing person with biographical data',
            );
          }

          if (personUpdated) {
            result.peopleUpdated++;
          }

          personIdMap.set(person.name, existingPerson.id);
          for (const alias of person.aliases) {
            personIdMap.set(alias, existingPerson.id);
          }
        } else {
          // No match found - create new person without additional matching
          // Note: We use createNew() instead of findOrCreate() because EntityMatcher
          // already determined there's no match (possibly due to biographical conflicts)
          const newPerson = await this.personRepo.createNew(
            familyId,
            person,
            conversationEventId,
            claimedBy,
            extractionVersion,
          );

          this.logger.debug(
            {
              familyId,
              personName: person.name,
              personId: newPerson.id,
            },
            'Created new person',
          );

          personIdMap.set(person.name, newPerson.id);
          for (const alias of person.aliases) {
            personIdMap.set(alias, newPerson.id);
          }
          result.peopleCreated++;
        }
      }

      // 2. Process Places
      for (const place of domainModel.places) {
        const dbPlace = await this.placeRepo.findOrCreate(
          familyId,
          place,
          conversationEventId,
          extractionVersion,
        );
        placeIdMap.set(place.name, dbPlace.id);
        if (new Date(dbPlace.createdAt).getTime() > Date.now() - 1000) {
          result.placesCreated++;
        }
      }

      // 3. Process Events (with deduplication)
      const createdEventIds: string[] = [];
      const eventIdMap = new Map<string, string>();
      for (const event of domainModel.events) {
        // Resolve place ID
        const placeId = event.placeName
          ? placeIdMap.get(event.placeName)
          : undefined;

        // Resolve people IDs first (needed for deduplication)
        const peopleIds = event.peopleInvolved
          .map((name) => personIdMap.get(name))
          .filter((id): id is string => !!id);

        // Find or create event (deduplicates based on title + people + date)
        const { event: dbEvent, created } = await this.eventRepo.findOrCreate(
          familyId,
          event,
          peopleIds,
          placeId,
          conversationEventId,
          claimedBy,
          extractionVersion,
        );
        createdEventIds.push(dbEvent.id);
        eventIdMap.set(event.title, dbEvent.id);

        if (created) {
          // New event - link all people
          if (peopleIds.length > 0) {
            await this.eventPeopleRepo.createMany(
              peopleIds.map((personId) => ({
                familyId,
                eventId: dbEvent.id,
                personId,
              })),
            );
          }
          result.eventsCreated++;
        } else {
          // Existing event - link any new people not already linked
          const existingLinks = await this.eventPeopleRepo.findByEvent(
            familyId,
            dbEvent.id,
          );
          const existingPersonIds = new Set(
            existingLinks.map((l) => l.personId),
          );
          const newPersonIds = peopleIds.filter(
            (id) => !existingPersonIds.has(id),
          );

          if (newPersonIds.length > 0) {
            await this.eventPeopleRepo.createMany(
              newPersonIds.map((personId) => ({
                familyId,
                eventId: dbEvent.id,
                personId,
              })),
            );
            this.logger.debug(
              {
                eventTitle: event.title,
                existingEventId: dbEvent.id,
                newPeopleLinked: newPersonIds.length,
              },
              'Linked additional people to existing event',
            );
          } else {
            this.logger.debug(
              { eventTitle: event.title, existingEventId: dbEvent.id },
              'Skipping duplicate event (all people already linked)',
            );
          }
        }
      }

      // 4. Process Relationships
      for (const rel of domainModel.relationships) {
        const personAId = personIdMap.get(rel.personAName);
        const personBId = personIdMap.get(rel.personBName);

        if (personAId && personBId) {
          const existing = await this.relationshipRepo.findBetween(
            familyId,
            personAId,
            personBId,
          );

          if (!existing) {
            await this.relationshipRepo.findOrCreate(
              familyId,
              personAId,
              personBId,
              rel.relationshipType,
              {
                conversationEventId,
                claimedBy,
                confidence: rel.confidence,
                extractionVersion,
              },
            );
            result.relationshipsCreated++;
          }
        }
      }

      // 5. Process Story (if present) — with deduplication
      if (domainModel.story) {
        // Fetch event to get original language if detected language not available
        const event = domainModel.detectedLanguage
          ? null
          : await this.eventRepo.findById(familyId, conversationEventId);
        const language =
          domainModel.detectedLanguage ||
          event?.descriptionLanguage ||
          'unknown';

        const allPeopleIds = [...new Set(personIdMap.values())];

        // Find or create story (deduplicates based on title + content + themes)
        const { story: dbStory, created } = await this.storyRepo.findOrCreate(
          familyId,
          domainModel.story,
          allPeopleIds,
          conversationEventId,
          language,
          claimedBy,
          extractionVersion,
        );

        if (created) {
          // New story — link all people, places, events
          if (allPeopleIds.length > 0) {
            await this.storyPeopleRepo.createMany(
              allPeopleIds.map((personId) => ({
                familyId,
                storyId: dbStory.id,
                personId,
              })),
            );
          }

          const placeIds = [...new Set(placeIdMap.values())];
          if (placeIds.length > 0) {
            await this.storyPlacesRepo.createMany(
              placeIds.map((placeId) => ({
                familyId,
                storyId: dbStory.id,
                placeId,
              })),
            );
          }

          if (createdEventIds.length > 0) {
            await this.storyEventsRepo.createMany(
              createdEventIds.map((eventId) => ({
                familyId,
                storyId: dbStory.id,
                eventId,
              })),
            );
          }

          // Link source conversation event
          await this.storyConversationEventsRepo.create({
            familyId,
            storyId: dbStory.id,
            conversationEventId,
          });

          result.storiesCreated++;
        } else {
          // Existing story — link any new people not already linked
          const existingPeopleLinks = await this.storyPeopleRepo.findByStory(
            familyId,
            dbStory.id,
          );
          const existingPersonIds = new Set(
            existingPeopleLinks.map((l) => l.personId),
          );
          const newPersonIds = allPeopleIds.filter(
            (id) => !existingPersonIds.has(id),
          );
          if (newPersonIds.length > 0) {
            await this.storyPeopleRepo.createMany(
              newPersonIds.map((personId) => ({
                familyId,
                storyId: dbStory.id,
                personId,
              })),
            );
          }

          // Link any new places not already linked
          const existingPlaceLinks = await this.storyPlacesRepo.findByStory(
            familyId,
            dbStory.id,
          );
          const existingPlaceIds = new Set(
            existingPlaceLinks.map((l) => l.placeId),
          );
          const allPlaceIds = [...new Set(placeIdMap.values())];
          const newPlaceIds = allPlaceIds.filter(
            (id) => !existingPlaceIds.has(id),
          );
          if (newPlaceIds.length > 0) {
            await this.storyPlacesRepo.createMany(
              newPlaceIds.map((placeId) => ({
                familyId,
                storyId: dbStory.id,
                placeId,
              })),
            );
          }

          // Link any new events not already linked
          if (createdEventIds.length > 0) {
            const existingEventLinks = await this.storyEventsRepo.findByStory(
              familyId,
              dbStory.id,
            );
            const existingEventIds = new Set(
              existingEventLinks.map((l) => l.eventId),
            );
            const newEventIds = createdEventIds.filter(
              (id) => !existingEventIds.has(id),
            );
            if (newEventIds.length > 0) {
              await this.storyEventsRepo.createMany(
                newEventIds.map((eventId) => ({
                  familyId,
                  storyId: dbStory.id,
                  eventId,
                })),
              );
            }
          }

          // Always link the new conversation event
          await this.storyConversationEventsRepo.create({
            familyId,
            storyId: dbStory.id,
            conversationEventId,
          });

          this.logger.debug(
            {
              storyTitle: domainModel.story.title,
              existingStoryId: dbStory.id,
              newPeopleLinked: newPersonIds.length,
              newPlacesLinked: newPlaceIds.length,
            },
            'Merged into existing story',
          );

          result.storiesUpdated++;
        }
      }

      // 6. Process Claims (with conflict detection and identity resolution)
      for (const claim of domainModel.claims) {
        // Skip claims with unresolved pronoun subjects
        const pronouns = [
          'he',
          'she',
          'they',
          'him',
          'her',
          'them',
          'his',
          'hers',
          'their',
        ];
        if (pronouns.includes(claim.subject.toLowerCase().trim())) {
          this.logger.warn(
            { familyId, subject: claim.subject, claimValue: claim.claimValue },
            'Skipping claim with unresolved pronoun subject',
          );
          continue;
        }

        // Skip claims from pure clarification questions (no factual assertion)
        const certLang = claim.certaintyLanguage?.toLowerCase();
        if (
          certLang &&
          (certLang === 'questioning' ||
            certLang === 'question' ||
            certLang === 'asking')
        ) {
          this.logger.debug(
            { familyId, subject: claim.subject, claimValue: claim.claimValue },
            'Skipping claim from clarification question',
          );
          continue;
        }

        // Skip claims with invalid types (database constraint)
        const validClaimTypes = [
          'date',
          'location',
          'relationship',
          'detail',
          'identity',
        ];
        if (!validClaimTypes.includes(claim.claimType)) {
          this.logger.warn(
            { familyId, claimType: claim.claimType, subject: claim.subject },
            'Skipping claim with invalid type (not in database constraint)',
          );
          continue;
        }

        // Find entity ID if we can resolve it
        let entityId: string | undefined;
        let entityType: 'person' | 'place' | 'event' | 'story' | undefined;

        // Try to resolve entity from subject
        // First try exact match
        let subjectPersonId = getEntityIdByName(personIdMap, claim.subject);

        if (!subjectPersonId) {
          subjectPersonId = resolveSingleReferencedEntity(
            claim.subject,
            claim.referencedPeople,
            personIdMap,
          );
        }

        // If no exact match, try extracting name from possessive subjects
        // e.g., "Beth's birth" → "Beth", "Timothy's age" → "Timothy"
        if (!subjectPersonId && claim.subject.includes("'s ")) {
          const possessiveName = claim.subject.split("'s ")[0].trim();
          subjectPersonId = getEntityIdByName(personIdMap, possessiveName);
        }

        if (!subjectPersonId) {
          subjectPersonId = resolveSingleMentionedEntity(
            claim.subject,
            personIdMap,
          );
        }

        if (subjectPersonId) {
          entityId = subjectPersonId;
          entityType = 'person';
        }

        // Resolve claim subject to a timeline event
        let subjectEventId: string | undefined;
        subjectEventId = getEntityIdByName(eventIdMap, claim.subject);

        if (!subjectEventId && claim.subject.includes("'s ")) {
          const possessiveName = claim.subject.split("'s ")[0].trim();
          subjectEventId = getEntityIdByName(eventIdMap, possessiveName);
        }

        if (!subjectEventId) {
          subjectEventId = resolveSingleMentionedEventTitle(
            claim.subject,
            eventIdMap,
          );
        }

        if (!subjectEventId) {
          subjectEventId = findBestSubjectMatch(claim.subject, eventIdMap);
        }

        // If no person resolved, use event as primary subject entity
        if (subjectEventId && !entityId) {
          entityId = subjectEventId;
          entityType = 'event';
        }

        // Handle identity claims - merge descriptive name with real name (using MergeHandlerService)
        // NOTE: This section will be created BEFORE the claim is persisted, so we can link entities properly
        let identityMerge:
          | { descriptiveId: string; canonicalId: string; mergeId?: string }
          | undefined;

        if (claim.claimType === 'identity' && claim.claimValue) {
          // claimValue can be a string or Record - handle both cases
          let realName: string | undefined;

          if (typeof claim.claimValue === 'string') {
            try {
              const parsed = JSON.parse(claim.claimValue);
              realName =
                typeof parsed === 'object' && parsed?.real_name
                  ? String(parsed.real_name)
                  : undefined;
            } catch {
              // If not JSON, the claimValue string itself might be the real name
              realName = claim.claimValue;
            }
          } else if (
            typeof claim.claimValue === 'object' &&
            claim.claimValue !== null
          ) {
            // claimValue is already an object
            realName = claim.claimValue.real_name
              ? String(claim.claimValue.real_name)
              : undefined;
          }

          if (realName && claim.subject) {
            // Find the person with the descriptive name (e.g., "Dexter's ex-wife")
            const descriptivePerson = await this.personRepo.findByFuzzyMatch(
              familyId,
              claim.subject,
              [],
            );

            if (descriptivePerson) {
              // Check if someone with the real name already exists
              const realNamePerson = await this.personRepo.findByFuzzyMatch(
                familyId,
                realName,
                [],
              );

              if (
                realNamePerson &&
                realNamePerson.id !== descriptivePerson.id
              ) {
                // Both exist - merge using MergeHandlerService
                const merge = await this.mergeHandlerService.mergeEntities(
                  familyId,
                  descriptivePerson.id,
                  realNamePerson.id,
                  'person',
                  {
                    strategy: 'identity_claim',
                    confidence: 1.0,
                    triggerEventId: conversationEventId,
                    reason: `Identity claim: "${claim.subject}" is "${realName}"`,
                  },
                );

                // Add the descriptive name as an alias to the real person
                const newAliases = [
                  ...(realNamePerson.aliases || []),
                  claim.subject,
                  ...(descriptivePerson.aliases || []).filter(
                    (a) => !a.startsWith('related-to:'),
                  ),
                ];
                await this.personRepo.updateAliases(
                  familyId,
                  realNamePerson.id,
                  [...new Set(newAliases)],
                );

                // Update the personIdMap to point to the real person
                personIdMap.set(claim.subject, realNamePerson.id);
                for (const alias of descriptivePerson.aliases || []) {
                  personIdMap.set(alias, realNamePerson.id);
                }

                identityMerge = {
                  descriptiveId: descriptivePerson.id,
                  canonicalId: realNamePerson.id,
                  mergeId: merge.id,
                };

                this.logger.info(
                  {
                    familyId,
                    descriptiveName: claim.subject,
                    realName,
                    mergedIntoId: realNamePerson.id,
                    mergeId: merge.id,
                  },
                  'Merged descriptive person into real person via identity claim',
                );
              } else if (!realNamePerson) {
                // Only descriptive person exists - update their name
                try {
                  await this.personRepo.updateName(
                    familyId,
                    descriptivePerson.id,
                    realName,
                    true, // Add old name as alias
                  );

                  // Update personIdMap
                  personIdMap.set(realName, descriptivePerson.id);
                  personIdMap.set(claim.subject, descriptivePerson.id);

                  identityMerge = {
                    descriptiveId: descriptivePerson.id,
                    canonicalId: descriptivePerson.id,
                  };

                  this.logger.info(
                    {
                      familyId,
                      descriptiveName: claim.subject,
                      realName,
                      personId: descriptivePerson.id,
                    },
                    'Updated person name from identity claim',
                  );
                } catch (error) {
                  this.logger.warn(
                    { err: error, personId: descriptivePerson.id },
                    'Failed to update person name from identity claim',
                  );
                }
              } else {
                // Both point to same person - just track the identity
                identityMerge = {
                  descriptiveId: descriptivePerson.id,
                  canonicalId: realNamePerson.id,
                };
              }
            }
          }
        }

        // Log attribution if it differs from sender
        if (claim.claimedBy !== claimedBy) {
          this.logger.debug(
            {
              familyId,
              subject: claim.subject,
              attributedTo: claim.claimedBy,
              reportedBy: claimedBy,
              sourceType: claim.claimedBySource,
            },
            'Claim attributed to different person than sender',
          );
        }

        // Check for conflicts using ConflictDetectorService
        // Only check conflicts with claims about the same entity
        const conflicts = await this.conflictDetectorService.detectConflicts(
          familyId,
          claim,
          entityId, // Pass resolved entity ID to filter conflicts
          entityType, // Pass entity type to filter conflicts
        );

        // Skip duplicate claims (claims that don't conflict and don't refine)
        const isDuplicate = conflicts.length === 0;
        if (isDuplicate) {
          // Check if exact same claim already exists
          const existingClaims = await this.claimRepo.findActiveBySubject(
            familyId,
            claim.subject,
          );
          const exactDuplicate = existingClaims.some(
            (existing) =>
              existing.claimType === claim.claimType &&
              subjectsMatch(existing.subject, claim.subject) &&
              !detectClaimConflict(existing.claimValue, claim.claimValue),
          );

          if (exactDuplicate) {
            this.logger.debug(
              { familyId, claimType: claim.claimType, subject: claim.subject },
              'Skipping duplicate claim',
            );
            continue;
          }
        }

        // Calculate claim strength using StrengthCalculatorService
        const isHighStakes = this.strengthCalculatorService.isHighStakesClaim(
          claim.claimType,
          claim.claimValue,
        );

        const contradictingConflicts = conflicts.filter(
          (c) => c.conflictType === 'contradicts',
        );

        const strengthResult = this.strengthCalculatorService.calculate(
          claim,
          contradictingConflicts.length,
          isHighStakes,
        );

        // Get existing claims with their strengths for conflict resolution
        const existingClaimsForResolution =
          await this.claimRepo.findActiveBySubject(familyId, claim.subject);

        // Fetch analysis for existing claims
        const existingClaimIds = existingClaimsForResolution.map((c) => c.id);
        const existingAnalyses = await this.claimAnalysisRepo.findByClaimIds(
          familyId,
          existingClaimIds,
        );
        const analysisMap = new Map(
          existingAnalyses.map((a) => [a.claimId, a]),
        );

        const conflictingClaimsWithStrength = contradictingConflicts
          .map((c) => {
            const analysis = analysisMap.get(c.conflictingClaimId!);
            return {
              claimId: c.conflictingClaimId!,
              claimStrength: analysis?.claimStrength,
            };
          })
          .filter((c) => c.claimId);

        // Resolve conflicts (decide what to do)
        const resolution = this.conflictDetectorService.resolveConflicts(
          strengthResult.score,
          conflictingClaimsWithStrength,
        );

        // Apply conflict resolution
        if (resolution.action === 'mark_disputed') {
          // Log that this claim is disputed but still create it
          this.logger.info(
            {
              familyId,
              subject: claim.subject,
              newClaimStrength: strengthResult.score,
              resolution: resolution.reasoning,
            },
            'Claim marked as disputed due to existing stronger or similar claims',
          );

          // If existing claim is significantly stronger, skip creating new claim
          const maxExistingStrength = Math.max(
            ...conflictingClaimsWithStrength.map((c) => c.claimStrength ?? 0.5),
          );

          if (strengthResult.score < maxExistingStrength - 0.2) {
            this.logger.info(
              {
                familyId,
                subject: claim.subject,
                newClaimStrength: strengthResult.score,
                maxExistingStrength,
              },
              'Skipping claim creation - existing claim is significantly stronger',
            );
            continue;
          }
        }

        // Create the new claim (immutable provenance)
        const newClaim = await this.claimRepo.createFromExtracted(
          familyId,
          claim,
          conversationEventId,
          claim.claimedBy,
          extractionVersion,
        );

        // Create analysis record (mutable system metadata)
        await this.claimAnalysisRepo.createForClaim(familyId, newClaim.id, {
          inferenceMethod: 'direct',
          claimStrength: strengthResult.score,
          strengthFactors: strengthResult.factors,
          needsLlmEvaluation: strengthResult.needsLlmEvaluation,
        });

        // Enqueue for LLM evaluation if needed
        if (strengthResult.needsLlmEvaluation) {
          const priority = isHighStakes ? 100 : 0;

          await this.llmQueueRepo.enqueue(
            familyId,
            'claim_strength',
            'claim',
            newClaim.id,
            {
              priority,
              context: {
                claimType: claim.claimType,
                subject: claim.subject,
                algorithmScore: strengthResult.score,
                triggers: strengthResult.factors.evaluationTriggered,
                sourceEventId: conversationEventId,
              },
            },
          );

          this.logger.debug(
            {
              familyId,
              claimId: newClaim.id,
              priority,
              triggers: strengthResult.factors.evaluationTriggered,
            },
            'Enqueued claim for LLM evaluation',
          );
        }

        // If resolution says to supersede existing claims
        if (resolution.action === 'supersede_existing') {
          for (const claimId of resolution.supersededClaimIds || []) {
            await this.claimRepo.markSuperseded(familyId, claimId);
            this.logger.info(
              {
                familyId,
                supersededClaimId: claimId,
                newClaimId: newClaim.id,
                newClaimStrength: strengthResult.score,
              },
              'Superseded existing claim with stronger new claim',
            );
          }
        }

        result.claimsCreated++;

        // Special handling for identity claims - create claim_entities links
        if (claim.claimType === 'identity' && identityMerge) {
          // Extract names from claimValue for metadata
          const descriptiveName = claim.subject;
          let canonicalName: string | undefined;

          if (
            typeof claim.claimValue === 'object' &&
            claim.claimValue !== null
          ) {
            canonicalName = claim.claimValue.real_name
              ? String(claim.claimValue.real_name)
              : undefined;
          } else if (typeof claim.claimValue === 'string') {
            try {
              const parsed = JSON.parse(claim.claimValue);
              canonicalName =
                typeof parsed === 'object' && parsed?.real_name
                  ? String(parsed.real_name)
                  : claim.claimValue;
            } catch {
              canonicalName = claim.claimValue;
            }
          }

          // Link identity_source (descriptive name)
          await this.claimEntityRepo.link(
            familyId,
            newClaim.id,
            identityMerge.descriptiveId,
            'person',
            {
              role: 'identity_source',
              resolved: !!identityMerge.mergeId,
              entityMergeId: identityMerge.mergeId,
              relationshipMetadata: {
                descriptive_name: descriptiveName,
              },
            },
          );

          // Link identity_target (canonical name)
          await this.claimEntityRepo.link(
            familyId,
            newClaim.id,
            identityMerge.canonicalId,
            'person',
            {
              role: 'identity_target',
              resolved: !!identityMerge.mergeId,
              entityMergeId: identityMerge.mergeId,
              relationshipMetadata: {
                canonical_name: canonicalName,
              },
            },
          );

          this.logger.debug(
            {
              familyId,
              claimId: newClaim.id,
              descriptiveId: identityMerge.descriptiveId,
              canonicalId: identityMerge.canonicalId,
              resolved: !!identityMerge.mergeId,
            },
            'Created identity claim entity links',
          );
        } else {
          // Regular claims - create claim-entity links using ClaimEntityRepository
          if (entityId && entityType) {
            await this.claimEntityRepo.link(
              familyId,
              newClaim.id,
              entityId,
              entityType as any,
              {
                role: 'subject',
              },
            );
          }
        }

        // Link referenced people and places
        if (claim.referencedPeople) {
          for (const personName of claim.referencedPeople) {
            const personId = getEntityIdByName(personIdMap, personName);
            if (
              personId &&
              !(entityType === 'person' && entityId === personId)
            ) {
              await this.claimEntityRepo.link(
                familyId,
                newClaim.id,
                personId,
                'person',
                {
                  role: 'related',
                },
              );
            }
          }
        }

        if (claim.referencedPlaces) {
          for (const placeName of claim.referencedPlaces) {
            const placeId = getEntityIdByName(placeIdMap, placeName);
            if (placeId && !(entityType === 'place' && entityId === placeId)) {
              await this.claimEntityRepo.link(
                familyId,
                newClaim.id,
                placeId,
                'place',
                {
                  role: 'location',
                },
              );
            }
          }
        }

        // Link claim to related event (when person is the primary subject)
        if (subjectEventId && entityType !== 'event') {
          await this.claimEntityRepo.link(
            familyId,
            newClaim.id,
            subjectEventId,
            'event',
            { role: 'related' },
          );
        }

        // Link people mentioned in claim subject or value
        const claimText = [
          claim.subject,
          typeof claim.claimValue === 'string'
            ? claim.claimValue
            : JSON.stringify(claim.claimValue),
        ]
          .join(' ')
          .toLowerCase();

        const linkedPersonIds = new Set<string>();
        if (entityType === 'person' && entityId) {
          linkedPersonIds.add(entityId);
        }

        for (const [personName, personId] of personIdMap) {
          if (linkedPersonIds.has(personId)) continue;
          // Word-boundary match (not raw substring): 'Ann' must not match inside
          // 'Anna'/'banana'. See name-match.ts and invariant 6.
          if (textMentionsName(claimText, personName)) {
            await this.claimEntityRepo.link(
              familyId,
              newClaim.id,
              personId,
              'person',
              { role: 'related' },
            );
            linkedPersonIds.add(personId);
          }
        }

        // Create claim relationships using ClaimRelationshipRepository
        for (const conflict of conflicts) {
          if (!conflict.conflictingClaimId) continue;

          if (conflict.hasConflict && conflict.conflictType === 'contradicts') {
            // Create conflict link in claim_conflicts table (legacy)
            await this.claimRepo.addConflict(
              familyId,
              newClaim.id,
              conflict.conflictingClaimId,
            );

            // Also create relationship in claim_relationships table (new)
            await this.claimRelationshipRepo.create(
              familyId,
              newClaim.id,
              conflict.conflictingClaimId,
              'contradicts',
            );

            result.conflictsDetected++;
            this.logger.info(
              {
                familyId,
                subject: claim.subject,
                newClaimId: newClaim.id,
                existingClaimId: conflict.conflictingClaimId,
                reasoning: conflict.reasoning,
              },
              'Conflict detected between claims',
            );
          } else if (conflict.conflictType === 'refines') {
            // Create refinement relationship
            await this.claimRelationshipRepo.create(
              familyId,
              newClaim.id,
              conflict.conflictingClaimId,
              'refines',
            );

            this.logger.debug(
              {
                familyId,
                newClaimId: newClaim.id,
                existingClaimId: conflict.conflictingClaimId,
              },
              'Claim refines existing claim',
            );
          }
        }
      }

      // 7. Process Image References
      for (const imageRef of domainModel.imageReferences || []) {
        try {
          // Handle people identification
          if (
            imageRef.referenceType === 'identifies_people' &&
            imageRef.peopleIdentified &&
            imageRef.peopleIdentified.length > 0
          ) {
            // Resolve person names to IDs
            const personIds: string[] = [];
            for (const personName of imageRef.peopleIdentified) {
              const personId = personIdMap.get(personName);
              if (personId) {
                personIds.push(personId);
              } else {
                // Try to find existing person by name
                const matchResult = await this.personRepo.findBestMatch(
                  familyId,
                  personName,
                  [],
                );
                if (matchResult) {
                  personIds.push(matchResult.person.id);
                  personIdMap.set(personName, matchResult.person.id);
                }
              }
            }

            if (personIds.length > 0) {
              await this.imageRepo.addConnectedPeople(
                familyId,
                imageRef.imageId,
                personIds,
              );
              this.logger.debug(
                {
                  familyId,
                  imageId: imageRef.imageId,
                  personIds,
                  peopleIdentified: imageRef.peopleIdentified,
                },
                'Added people to image',
              );
            }
          }

          // Handle context provided
          if (
            (imageRef.referenceType === 'provides_context' ||
              imageRef.referenceType === 'describes') &&
            imageRef.contextProvided
          ) {
            await this.imageRepo.addContext(
              familyId,
              imageRef.imageId,
              imageRef.contextProvided,
              conversationEventId,
            );
            this.logger.debug(
              {
                familyId,
                imageId: imageRef.imageId,
                context: imageRef.contextProvided.slice(0, 100),
              },
              'Added context to image',
            );
          }

          result.imageReferencesProcessed++;
        } catch (error) {
          this.logger.warn(
            {
              imageId: imageRef.imageId,
              referenceType: imageRef.referenceType,
              error,
            },
            'Failed to process image reference',
          );
        }
      }

      // 10. Log completion
      await this.eventLog.log({
        familyId,
        eventType: 'event_processed',
        eventCategory: 'system_event',
        actor: 'registrar',
        actorType: 'system',
        conversationEventId,
        eventData: result as unknown as Record<string, unknown>,
      });

      this.logger.info(
        { familyId, conversationEventId, ...result },
        'Registrar persist complete',
      );
    } catch (error) {
      this.logger.error(
        { familyId, conversationEventId, err: error },
        'Registrar persist failed',
      );

      // Log the error
      await this.eventLog.log({
        familyId,
        eventType: 'error',
        eventCategory: 'system_event',
        actor: 'registrar',
        actorType: 'system',
        conversationEventId,
        severity: 'error',
        eventData: {
          error: error instanceof Error ? error.message : String(error),
          partialResult: result as unknown as Record<string, unknown>,
        } as Record<string, unknown>,
      });

      throw error;
    }
  }
}
