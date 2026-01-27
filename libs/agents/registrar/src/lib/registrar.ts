import type { ScribeDomainModel } from '@sobremesa/shared-types';
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
} from '@sobremesa/database';
import { createLogger } from '@sobremesa/shared-utils';
import type pino from 'pino';
import {
  detectClaimConflict,
  subjectsMatch,
  canClaimTypeConflict,
} from './conflict-detector';
import {
  EntityMatcherService,
  ConflictDetectorService,
  MergeHandlerService,
  StrengthCalculatorService,
} from './services';

/**
 * Options for creating a RegistrarAgent.
 */
export interface RegistrarAgentOptions {
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
    // Repositories
    this.personRepo = options.personRepo || new PersonRepository();
    this.placeRepo = options.placeRepo || new PlaceRepository();
    this.eventRepo = options.eventRepo || new TimelineEventRepository();
    this.storyRepo = options.storyRepo || new StoryRepository();
    this.claimRepo = options.claimRepo || new ClaimRepository();
    this.claimAnalysisRepo =
      options.claimAnalysisRepo || new ClaimAnalysisRepository();
    this.relationshipRepo =
      options.relationshipRepo || new RelationshipRepository();
    this.eventLog = options.eventLog || new EventLogRepository();
    this.conversationEventRepo =
      options.conversationEventRepo || new ConversationEventRepository();
    this.imageRepo = options.imageRepo || new ImageRepository();
    this.entityMergeRepo =
      options.entityMergeRepo || new EntityMergeRepository();
    this.claimEntityRepo =
      options.claimEntityRepo || new ClaimEntityRepository();
    this.claimRelationshipRepo =
      options.claimRelationshipRepo || new ClaimRelationshipRepository();
    this.llmQueueRepo =
      options.llmQueueRepo || new LlmEvaluationQueueRepository();
    this.logger = options.logger || createLogger({ name: 'registrar' });

    // Phase 2: Join table repositories
    this.storyPeopleRepo =
      options.storyPeopleRepo || new StoryPeopleRepository();
    this.storyPlacesRepo =
      options.storyPlacesRepo || new StoryPlacesRepository();
    this.storyEventsRepo =
      options.storyEventsRepo || new StoryEventsRepository();
    this.storyConversationEventsRepo =
      options.storyConversationEventsRepo ||
      new StoryConversationEventsRepository();
    this.eventPeopleRepo =
      options.eventPeopleRepo || new EventPeopleRepository();
    // Note: EventPlacesRepository initialized for future use - events currently use single placeId field
    this.eventPlacesRepo =
      options.eventPlacesRepo || new EventPlacesRepository();
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
   */
  async persist(
    domainModel: ScribeDomainModel,
    familyId: string,
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
      claimsCreated: 0,
      conflictsDetected: 0,
      relationshipsCreated: 0,
      imageReferencesProcessed: 0,
    };

    const conversationEventId = domainModel.conversationEventId;

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
          if (
            matchResult.suggestedAliases &&
            matchResult.suggestedAliases.length > 0
          ) {
            await this.personRepo.updateAliases(familyId, existingPerson.id, [
              ...existingPerson.aliases,
              ...matchResult.suggestedAliases,
            ]);
            result.peopleUpdated++;

            this.logger.debug(
              {
                familyId,
                personId: existingPerson.id,
                newAliases: matchResult.suggestedAliases,
              },
              'Added aliases to existing person',
            );
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
        );
        placeIdMap.set(place.name, dbPlace.id);
        if (new Date(dbPlace.createdAt).getTime() > Date.now() - 1000) {
          result.placesCreated++;
        }
      }

      // 3. Process Events
      const createdEventIds: string[] = [];
      for (const event of domainModel.events) {
        // Resolve place ID
        const placeId = event.placeName
          ? placeIdMap.get(event.placeName)
          : undefined;

        // Create event without people associations
        const createdEvent = await this.eventRepo.createFromExtracted(
          familyId,
          event,
          placeId,
          conversationEventId,
          claimedBy,
        );
        createdEventIds.push(createdEvent.id);

        // Link people via event_people join table
        const peopleIds = event.peopleInvolved
          .map((name) => personIdMap.get(name))
          .filter((id): id is string => !!id);

        if (peopleIds.length > 0) {
          await this.eventPeopleRepo.createMany(
            peopleIds.map((personId) => ({
              familyId,
              eventId: createdEvent.id,
              personId,
            })),
          );
        }

        result.eventsCreated++;
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
              },
            );
            result.relationshipsCreated++;
          }
        }
      }

      // 5. Process Story (if present)
      if (domainModel.story) {
        // Create story without entity associations
        const createdStory = await this.storyRepo.createFromExtracted(
          familyId,
          domainModel.story,
          conversationEventId,
          domainModel.detectedLanguage,
          claimedBy,
        );

        // Link people via story_people join table
        const peopleIds = [...personIdMap.values()];
        if (peopleIds.length > 0) {
          await this.storyPeopleRepo.createMany(
            peopleIds.map((personId) => ({
              familyId,
              storyId: createdStory.id,
              personId,
            })),
          );
        }

        // Link places via story_places join table
        const placeIds = [...placeIdMap.values()];
        if (placeIds.length > 0) {
          await this.storyPlacesRepo.createMany(
            placeIds.map((placeId) => ({
              familyId,
              storyId: createdStory.id,
              placeId,
            })),
          );
        }

        // Link events via story_events join table
        if (createdEventIds.length > 0) {
          await this.storyEventsRepo.createMany(
            createdEventIds.map((eventId) => ({
              familyId,
              storyId: createdStory.id,
              eventId,
            })),
          );
        }

        // Link source conversation event via story_conversation_events join table
        await this.storyConversationEventsRepo.create({
          familyId,
          storyId: createdStory.id,
          conversationEventId: conversationEventId,
        });

        result.storiesCreated++;
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
        let subjectPersonId = personIdMap.get(claim.subject);

        // If no exact match, try extracting name from possessive subjects
        // e.g., "Beth's birth" → "Beth", "Timothy's age" → "Timothy"
        if (!subjectPersonId && claim.subject.includes("'s ")) {
          const possessiveName = claim.subject.split("'s ")[0].trim();
          subjectPersonId = personIdMap.get(possessiveName);
        }

        if (subjectPersonId) {
          entityId = subjectPersonId;
          entityType = 'person';
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
                    { error, personId: descriptivePerson.id },
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
        const isDuplicate =
          conflicts.length === 0 && canClaimTypeConflict(claim.claimType);
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
            const personId = personIdMap.get(personName);
            if (personId) {
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
            const placeId = placeIdMap.get(placeName);
            if (placeId) {
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
        { familyId, conversationEventId, error },
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
