import type { ScribeDomainModel } from '@sobremesa/shared-types';
import {
  PersonRepository,
  PlaceRepository,
  TimelineEventRepository,
  StoryRepository,
  ClaimRepository,
  RelationshipRepository,
  QuestionRepository,
  EventLogRepository,
  ConversationEventRepository,
  ImageRepository,
} from '@sobremesa/database';
import { createLogger } from '@sobremesa/shared-utils';
import type pino from 'pino';
import { detectClaimConflict, subjectsMatch } from './conflict-detector';

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
  /** Relationship repository */
  relationshipRepo?: RelationshipRepository;
  /** Question repository */
  questionRepo?: QuestionRepository;
  /** Event log repository */
  eventLog?: EventLogRepository;
  /** Conversation event repository (for getting claimedBy info) */
  conversationEventRepo?: ConversationEventRepository;
  /** Image repository (for linking people to images) */
  imageRepo?: ImageRepository;
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
  questionsCreated: number;
  answersProcessed: number;
  imageReferencesProcessed: number;
}

/**
 * The Registrar agent persists extracted data to the database.
 * It handles deduplication, conflict detection, and provenance tracking.
 */
export class RegistrarAgent {
  private personRepo: PersonRepository;
  private placeRepo: PlaceRepository;
  private eventRepo: TimelineEventRepository;
  private storyRepo: StoryRepository;
  private claimRepo: ClaimRepository;
  private relationshipRepo: RelationshipRepository;
  private questionRepo: QuestionRepository;
  private eventLog: EventLogRepository;
  private conversationEventRepo: ConversationEventRepository;
  private imageRepo: ImageRepository;
  private logger: pino.Logger;

  constructor(options: RegistrarAgentOptions = {}) {
    this.personRepo = options.personRepo || new PersonRepository();
    this.placeRepo = options.placeRepo || new PlaceRepository();
    this.eventRepo = options.eventRepo || new TimelineEventRepository();
    this.storyRepo = options.storyRepo || new StoryRepository();
    this.claimRepo = options.claimRepo || new ClaimRepository();
    this.relationshipRepo =
      options.relationshipRepo || new RelationshipRepository();
    this.questionRepo = options.questionRepo || new QuestionRepository();
    this.eventLog = options.eventLog || new EventLogRepository();
    this.conversationEventRepo =
      options.conversationEventRepo || new ConversationEventRepository();
    this.imageRepo = options.imageRepo || new ImageRepository();
    this.logger = options.logger || createLogger({ name: 'registrar' });
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
      { familyId, sourceEventId: domainModel.sourceEventId },
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
      questionsCreated: 0,
      answersProcessed: 0,
      imageReferencesProcessed: 0,
    };

    const sourceEventId = domainModel.sourceEventId;

    // Get the claimedBy from the source event
    const sourceEvent = await this.conversationEventRepo.findById(
      familyId,
      sourceEventId,
    );
    const claimedBy =
      sourceEvent?.actorDisplayName || sourceEvent?.actorUsername || 'Unknown';

    // Build maps for name -> ID resolution
    const personIdMap = new Map<string, string>();
    const placeIdMap = new Map<string, string>();

    try {
      // 1. Process People (with smart matching)
      for (const person of domainModel.people) {
        const matchResult = await this.personRepo.findBestMatch(
          familyId,
          person.name,
          person.aliases,
        );

        if (matchResult) {
          const {
            person: existingPerson,
            confidence,
            matchReason,
          } = matchResult;

          this.logger.debug(
            {
              familyId,
              extractedName: person.name,
              matchedName: existingPerson.name,
              matchedId: existingPerson.id,
              confidence,
              matchReason,
            },
            'Person matched to existing',
          );

          // Add the extracted name as an alias if it's not already there
          const existingAliases = new Set(
            (existingPerson.aliases || []).map((a) => a.toLowerCase()),
          );
          const newAliases = [person.name, ...person.aliases].filter(
            (a) =>
              !existingAliases.has(a.toLowerCase()) &&
              a.toLowerCase() !== existingPerson.name.toLowerCase(),
          );

          if (newAliases.length > 0) {
            await this.personRepo.updateAliases(familyId, existingPerson.id, [
              ...existingPerson.aliases,
              ...newAliases,
            ]);
            result.peopleUpdated++;

            this.logger.debug(
              { familyId, personId: existingPerson.id, newAliases },
              'Added aliases to existing person',
            );
          }

          personIdMap.set(person.name, existingPerson.id);
          for (const alias of person.aliases) {
            personIdMap.set(alias, existingPerson.id);
          }
        } else {
          // No match found - create new person
          const newPerson = await this.personRepo.findOrCreate(
            familyId,
            person,
            sourceEventId,
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
          sourceEventId,
        );
        placeIdMap.set(place.name, dbPlace.id);
        if (new Date(dbPlace.createdAt).getTime() > Date.now() - 1000) {
          result.placesCreated++;
        }
      }

      // 3. Process Events
      for (const event of domainModel.events) {
        // Resolve people IDs
        const peopleIds = event.peopleInvolved
          .map((name) => personIdMap.get(name))
          .filter((id): id is string => !!id);

        // Resolve place ID
        const placeId = event.placeName
          ? placeIdMap.get(event.placeName)
          : undefined;

        await this.eventRepo.createFromExtracted(
          familyId,
          event,
          peopleIds,
          placeId,
          sourceEventId,
          claimedBy,
        );
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
                sourceEventId,
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
        const peopleIds = [...personIdMap.values()];
        const placeIds = [...placeIdMap.values()];

        await this.storyRepo.createFromExtracted(
          familyId,
          domainModel.story,
          peopleIds,
          placeIds,
          [], // eventIds - would need to track created event IDs
          sourceEventId,
          domainModel.detectedLanguage,
          claimedBy,
        );
        result.storiesCreated++;
      }

      // 6. Process Claims (with conflict detection)
      for (const claim of domainModel.claims) {
        // Find entity ID if we can resolve it
        let entityId: string | undefined;
        let entityType: 'person' | 'place' | 'event' | 'story' | undefined;

        // Try to resolve entity from subject
        const subjectPersonId = personIdMap.get(claim.subject);
        if (subjectPersonId) {
          entityId = subjectPersonId;
          entityType = 'person';
        }

        // Check for conflicts with existing claims
        const existingClaims = await this.claimRepo.findActiveBySubject(
          familyId,
          claim.subject,
        );

        // Determine who made this claim:
        // - Use Scribe's extracted claimedBy if available (e.g., "Mom" in "Mom told me...")
        // - Fall back to message sender
        const effectiveClaimedBy = claim.claimedBy || claimedBy;

        // Log attribution if it differs from sender
        if (claim.claimedBy && claim.claimedBy !== claimedBy) {
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

        // Create the new claim
        const newClaim = await this.claimRepo.createFromExtracted(
          familyId,
          claim,
          sourceEventId,
          effectiveClaimedBy,
          entityId,
          entityType,
        );
        result.claimsCreated++;

        // Check for conflicts and create links
        for (const existing of existingClaims) {
          if (
            subjectsMatch(existing.subject, claim.subject) &&
            detectClaimConflict(existing.claimValue, claim.claimValue)
          ) {
            await this.claimRepo.addConflict(
              familyId,
              newClaim.id,
              existing.id,
            );
            result.conflictsDetected++;
            this.logger.info(
              {
                familyId,
                subject: claim.subject,
                newClaimId: newClaim.id,
                existingClaimId: existing.id,
              },
              'Conflict detected between claims',
            );
          }
        }
      }

      // 7. Process Questions
      for (const question of domainModel.questions) {
        await this.questionRepo.createFromGenerated(
          familyId,
          question,
          sourceEventId,
        );
        result.questionsCreated++;
      }

      // 8. Process Detected Answers
      for (const answer of domainModel.answers) {
        try {
          await this.questionRepo.markAnswered(
            familyId,
            answer.questionId,
            sourceEventId,
          );
          result.answersProcessed++;
        } catch (error) {
          this.logger.warn(
            { questionId: answer.questionId, error },
            'Failed to mark question as answered',
          );
        }
      }

      // 9. Process Image References
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
              sourceEventId,
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
        sourceEventId,
        eventData: result as unknown as Record<string, unknown>,
      });

      this.logger.info(
        { familyId, sourceEventId, ...result },
        'Registrar persist complete',
      );
    } catch (error) {
      this.logger.error(
        { familyId, sourceEventId, error },
        'Registrar persist failed',
      );

      // Log the error
      await this.eventLog.log({
        familyId,
        eventType: 'error',
        eventCategory: 'system_event',
        actor: 'registrar',
        actorType: 'system',
        sourceEventId,
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
