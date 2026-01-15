import {
  PersonRepository,
  ClaimRepository,
  RelationshipRepository,
  TimelineEventRepository,
  StoryRepository,
  PlaceRepository,
  ImageRepository,
} from '@sobremesa/database';
import type { Confidence } from '@sobremesa/shared-types';
import type {
  ParsedQuestion,
  RetrievedContext,
  ClaimWithSource,
  TimelineEventInfo,
  StorySummary,
  ImageInfo,
  HistorianConfig,
} from './types';

/**
 * Retriever for fetching relevant data from the database.
 */
export class DataRetriever {
  private personRepo: PersonRepository;
  private claimRepo: ClaimRepository;
  private relationshipRepo: RelationshipRepository;
  private eventRepo: TimelineEventRepository;
  private storyRepo: StoryRepository;
  private placeRepo: PlaceRepository;
  private imageRepo: ImageRepository;

  constructor(options?: {
    personRepo?: PersonRepository;
    claimRepo?: ClaimRepository;
    relationshipRepo?: RelationshipRepository;
    eventRepo?: TimelineEventRepository;
    storyRepo?: StoryRepository;
    placeRepo?: PlaceRepository;
    imageRepo?: ImageRepository;
  }) {
    this.personRepo = options?.personRepo || new PersonRepository();
    this.claimRepo = options?.claimRepo || new ClaimRepository();
    this.relationshipRepo =
      options?.relationshipRepo || new RelationshipRepository();
    this.eventRepo = options?.eventRepo || new TimelineEventRepository();
    this.storyRepo = options?.storyRepo || new StoryRepository();
    this.placeRepo = options?.placeRepo || new PlaceRepository();
    this.imageRepo = options?.imageRepo || new ImageRepository();
  }

  /**
   * Retrieve context for answering a question.
   */
  async retrieve(
    familyId: string,
    question: ParsedQuestion,
    config: HistorianConfig,
  ): Promise<RetrievedContext> {
    const context: RetrievedContext = {
      people: [],
      events: [],
      stories: [],
      claims: [],
      relationships: [],
      images: [],
      hasConflicts: false,
      conflicts: new Map(),
    };

    // Strategy depends on question type
    switch (question.type) {
      case 'person_info':
        await this.retrieveForPersonInfo(familyId, question, config, context);
        break;
      case 'relationship':
        await this.retrieveForRelationship(familyId, question, config, context);
        break;
      case 'timeline':
        await this.retrieveForTimeline(familyId, question, config, context);
        break;
      case 'location':
        await this.retrieveForLocation(familyId, question, config, context);
        break;
      case 'event':
        await this.retrieveForEvent(familyId, question, config, context);
        break;
      case 'story':
        await this.retrieveForStory(familyId, question, config, context);
        break;
      case 'verification':
        await this.retrieveForVerification(familyId, question, config, context);
        break;
      case 'general':
      default:
        await this.retrieveForGeneral(familyId, question, config, context);
        break;
    }

    // Detect conflicts in retrieved claims
    this.detectConflicts(context);

    return context;
  }

  /**
   * Retrieve context for person_info questions.
   */
  private async retrieveForPersonInfo(
    familyId: string,
    question: ParsedQuestion,
    config: HistorianConfig,
    context: RetrievedContext,
  ): Promise<void> {
    // Find people matching entity names
    for (const entity of question.entities) {
      const person = await this.personRepo.findByFuzzyMatch(familyId, entity);
      if (person) {
        // Get claims about this person
        const claims = await this.claimRepo.findByEntity(
          familyId,
          'person',
          person.id,
        );
        context.people.push({
          person,
          claims: claims.slice(0, config.maxClaimsPerQuery).map(this.mapClaim),
        });

        // Get relationships
        const relationships = await this.relationshipRepo.findByPerson(
          familyId,
          person.id,
        );
        context.relationships.push(...relationships);

        // Get events involving this person
        const events = await this.eventRepo.findByPerson(familyId, person.id);
        context.events.push(
          ...events.slice(0, config.maxEvents).map(this.mapEvent),
        );

        // Get images with this person
        const images = await this.imageRepo.findByPerson(familyId, person.id);
        context.images.push(...images.slice(0, 5).map(this.mapImage));
      }
    }

    // If no people found by name, search by keywords
    if (context.people.length === 0 && question.keywords.length > 0) {
      const allPeople = await this.personRepo.findAllActive(familyId);
      for (const person of allPeople) {
        const nameMatch = question.keywords.some(
          (kw) =>
            person.name.toLowerCase().includes(kw) ||
            person.aliases?.some((a: string) => a.toLowerCase().includes(kw)),
        );
        if (nameMatch) {
          const claims = await this.claimRepo.findByEntity(
            familyId,
            'person',
            person.id,
          );
          context.people.push({
            person,
            claims: claims
              .slice(0, config.maxClaimsPerQuery)
              .map(this.mapClaim),
          });
        }
      }
    }
  }

  /**
   * Retrieve context for relationship questions.
   */
  private async retrieveForRelationship(
    familyId: string,
    question: ParsedQuestion,
    config: HistorianConfig,
    context: RetrievedContext,
  ): Promise<void> {
    // Find the people mentioned
    const peopleFound: string[] = [];
    for (const entity of question.entities) {
      const person = await this.personRepo.findByFuzzyMatch(familyId, entity);
      if (person) {
        peopleFound.push(person.id);
        context.people.push({ person, claims: [] });
      }
    }

    // If we have two people, find relationship between them
    if (peopleFound.length >= 2) {
      const relationship = await this.relationshipRepo.findBetween(
        familyId,
        peopleFound[0],
        peopleFound[1],
      );
      if (relationship) {
        context.relationships.push(relationship);
      }
    }

    // Get all relationships for the people found
    for (const personId of peopleFound) {
      const relationships = await this.relationshipRepo.findByPerson(
        familyId,
        personId,
      );
      context.relationships.push(...relationships);
    }

    // Deduplicate relationships
    const seen = new Set<string>();
    context.relationships = context.relationships.filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
  }

  /**
   * Retrieve context for timeline questions.
   */
  private async retrieveForTimeline(
    familyId: string,
    question: ParsedQuestion,
    config: HistorianConfig,
    context: RetrievedContext,
  ): Promise<void> {
    // Get events matching time references
    if (question.timeReferences.length > 0) {
      for (const timeRef of question.timeReferences) {
        const year = parseInt(timeRef.match(/\d{4}/)?.[0] || '0', 10);
        if (year > 1800 && year < 2100) {
          const events = await this.eventRepo.findByTimeRange(
            familyId,
            year - 5,
            year + 5,
          );
          context.events.push(
            ...events.slice(0, config.maxEvents).map(this.mapEvent),
          );
        }
      }
    }

    // Get events involving mentioned people
    for (const entity of question.entities) {
      const person = await this.personRepo.findByFuzzyMatch(familyId, entity);
      if (person) {
        const events = await this.eventRepo.findByPerson(familyId, person.id);
        context.events.push(
          ...events.slice(0, config.maxEvents).map(this.mapEvent),
        );
        context.people.push({ person, claims: [] });
      }
    }

    // Get claims about dates
    const allClaims = await this.claimRepo.findAllActive(familyId);
    const dateClaims = allClaims.filter(
      (c: { claimType?: string | null; subject: string }) =>
        c.claimType === 'date' ||
        c.subject.toLowerCase().includes('year') ||
        c.subject.toLowerCase().includes('when'),
    );
    context.claims.push(
      ...dateClaims.slice(0, config.maxClaimsPerQuery).map(this.mapClaim),
    );

    // Deduplicate events
    const seen = new Set<string>();
    context.events = context.events.filter((e) => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });
  }

  /**
   * Retrieve context for location questions.
   */
  private async retrieveForLocation(
    familyId: string,
    question: ParsedQuestion,
    config: HistorianConfig,
    context: RetrievedContext,
  ): Promise<void> {
    // Search for places by keyword
    const allPlaces = await this.placeRepo.findAllActive(familyId);
    const matchingPlaces = allPlaces.filter(
      (place: {
        name: string;
        city?: string | null;
        country?: string | null;
      }) =>
        question.keywords.some(
          (kw) =>
            place.name.toLowerCase().includes(kw) ||
            place.city?.toLowerCase().includes(kw) ||
            place.country?.toLowerCase().includes(kw),
        ),
    );

    // Get claims about places
    for (const place of matchingPlaces.slice(0, 5)) {
      const claims = await this.claimRepo.findByEntity(
        familyId,
        'place',
        place.id,
      );
      context.claims.push(
        ...claims.slice(0, config.maxClaimsPerQuery).map(this.mapClaim),
      );
    }

    // Get people mentioned
    for (const entity of question.entities) {
      const person = await this.personRepo.findByFuzzyMatch(familyId, entity);
      if (person) {
        const claims = await this.claimRepo.findByEntity(
          familyId,
          'person',
          person.id,
        );
        // Filter for location-related claims
        const locationClaims = claims.filter(
          (c: { subject: string }) =>
            c.subject.toLowerCase().includes('born') ||
            c.subject.toLowerCase().includes('live') ||
            c.subject.toLowerCase().includes('from') ||
            c.subject.toLowerCase().includes('location') ||
            c.subject.toLowerCase().includes('place'),
        );
        context.claims.push(
          ...locationClaims
            .slice(0, config.maxClaimsPerQuery)
            .map(this.mapClaim),
        );
        context.people.push({ person, claims: [] });
      }
    }
  }

  /**
   * Retrieve context for event questions.
   */
  private async retrieveForEvent(
    familyId: string,
    question: ParsedQuestion,
    config: HistorianConfig,
    context: RetrievedContext,
  ): Promise<void> {
    // Search events by keywords
    const allEvents = await this.eventRepo.findAllActive(familyId);
    const matchingEvents = allEvents.filter(
      (event: { title: string; eventType?: string | null }) =>
        question.keywords.some(
          (kw) =>
            event.title.toLowerCase().includes(kw) ||
            event.eventType?.toLowerCase().includes(kw),
        ),
    );

    context.events.push(
      ...matchingEvents.slice(0, config.maxEvents).map(this.mapEvent),
    );

    // Get related stories
    for (const event of matchingEvents.slice(0, 3)) {
      const stories = await this.storyRepo.findAllActive(familyId);
      const relatedStories = stories.filter(
        (s) =>
          s.title &&
          (s.title.toLowerCase().includes(event.title.toLowerCase()) ||
            event.title.toLowerCase().includes(s.title.toLowerCase())),
      );
      context.stories.push(
        ...relatedStories.slice(0, config.maxStories).map(this.mapStory),
      );
    }

    // Get people mentioned
    for (const entity of question.entities) {
      const person = await this.personRepo.findByFuzzyMatch(familyId, entity);
      if (person) {
        context.people.push({ person, claims: [] });
      }
    }
  }

  /**
   * Retrieve context for story questions.
   */
  private async retrieveForStory(
    familyId: string,
    question: ParsedQuestion,
    config: HistorianConfig,
    context: RetrievedContext,
  ): Promise<void> {
    // Search stories by keywords and themes
    const allStories = await this.storyRepo.findAllActive(familyId);
    const matchingStories = allStories.filter((story) =>
      question.keywords.some(
        (kw) =>
          story.title?.toLowerCase().includes(kw) ||
          story.contentOriginal?.toLowerCase().includes(kw) ||
          story.themes?.some((t: string) => t.toLowerCase().includes(kw)),
      ),
    );

    context.stories.push(
      ...matchingStories.slice(0, config.maxStories).map(this.mapStory),
    );

    // Get claims related to stories
    for (const story of matchingStories.slice(0, 3)) {
      const claims = await this.claimRepo.findByEntity(
        familyId,
        'story',
        story.id,
      );
      context.claims.push(
        ...claims.slice(0, config.maxClaimsPerQuery).map(this.mapClaim),
      );
    }

    // Get people mentioned
    for (const entity of question.entities) {
      const person = await this.personRepo.findByFuzzyMatch(familyId, entity);
      if (person) {
        const stories = await this.storyRepo.findByPerson(familyId, person.id);
        context.stories.push(
          ...stories.slice(0, config.maxStories).map(this.mapStory),
        );
        context.people.push({ person, claims: [] });
      }
    }

    // Deduplicate stories
    const seen = new Set<string>();
    context.stories = context.stories.filter((s) => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });
  }

  /**
   * Retrieve context for verification questions.
   */
  private async retrieveForVerification(
    familyId: string,
    question: ParsedQuestion,
    config: HistorianConfig,
    context: RetrievedContext,
  ): Promise<void> {
    // Search all claims for matching keywords
    const allClaims = await this.claimRepo.findAllActive(familyId);
    const matchingClaims = allClaims.filter(
      (claim: { subject: string; claimValue: unknown }) =>
        question.keywords.some(
          (kw) =>
            claim.subject.toLowerCase().includes(kw) ||
            JSON.stringify(claim.claimValue).toLowerCase().includes(kw),
        ),
    );

    context.claims.push(
      ...matchingClaims.slice(0, config.maxClaimsPerQuery).map(this.mapClaim),
    );

    // Get people mentioned
    for (const entity of question.entities) {
      const person = await this.personRepo.findByFuzzyMatch(familyId, entity);
      if (person) {
        const claims = await this.claimRepo.findByEntity(
          familyId,
          'person',
          person.id,
        );
        context.claims.push(
          ...claims.slice(0, config.maxClaimsPerQuery).map(this.mapClaim),
        );
        context.people.push({ person, claims: [] });
      }
    }
  }

  /**
   * Retrieve context for general questions.
   */
  private async retrieveForGeneral(
    familyId: string,
    question: ParsedQuestion,
    config: HistorianConfig,
    context: RetrievedContext,
  ): Promise<void> {
    // Get people by entity names
    for (const entity of question.entities) {
      const person = await this.personRepo.findByFuzzyMatch(familyId, entity);
      if (person) {
        const claims = await this.claimRepo.findByEntity(
          familyId,
          'person',
          person.id,
        );
        context.people.push({
          person,
          claims: claims.slice(0, config.maxClaimsPerQuery).map(this.mapClaim),
        });
      }
    }

    // Get stories matching keywords
    const allStories = await this.storyRepo.findAllActive(familyId);
    const matchingStories = allStories.filter((story) =>
      question.keywords.some(
        (kw) =>
          story.title?.toLowerCase().includes(kw) ||
          story.contentOriginal?.toLowerCase().includes(kw),
      ),
    );
    context.stories.push(
      ...matchingStories.slice(0, config.maxStories).map(this.mapStory),
    );

    // Get events matching keywords
    const allEvents = await this.eventRepo.findAllActive(familyId);
    const matchingEvents = allEvents.filter((event: { title: string }) =>
      question.keywords.some((kw) => event.title.toLowerCase().includes(kw)),
    );
    context.events.push(
      ...matchingEvents.slice(0, config.maxEvents).map(this.mapEvent),
    );

    // If still no context, get some general claims
    if (
      context.people.length === 0 &&
      context.stories.length === 0 &&
      context.events.length === 0
    ) {
      const allClaims = await this.claimRepo.findAllActive(familyId);
      const matchingClaims = allClaims.filter(
        (claim: { subject: string; claimValue: unknown }) =>
          question.keywords.some(
            (kw) =>
              claim.subject.toLowerCase().includes(kw) ||
              JSON.stringify(claim.claimValue).toLowerCase().includes(kw),
          ),
      );
      context.claims.push(
        ...matchingClaims.slice(0, config.maxClaimsPerQuery).map(this.mapClaim),
      );
    }
  }

  /**
   * Detect conflicts in the retrieved claims.
   */
  private detectConflicts(context: RetrievedContext): void {
    // Group claims by subject
    const claimsBySubject = new Map<string, ClaimWithSource[]>();

    const allClaims = [
      ...context.claims,
      ...context.people.flatMap((p) => p.claims),
    ];

    for (const claim of allClaims) {
      const existing = claimsBySubject.get(claim.subject) || [];
      existing.push(claim);
      claimsBySubject.set(claim.subject, existing);
    }

    // Find subjects with conflicting values
    for (const [subject, claims] of claimsBySubject.entries()) {
      if (claims.length > 1) {
        // Check if values actually differ
        const values = claims.map((c) => JSON.stringify(c.claimValue));
        const uniqueValues = [...new Set(values)];
        if (uniqueValues.length > 1) {
          context.hasConflicts = true;
          context.conflicts.set(subject, claims);
        }
      }
    }
  }

  /**
   * Map a database claim to ClaimWithSource.
   */
  private mapClaim = (claim: {
    id: string;
    subject: string;
    claimValue: unknown;
    confidence: string;
    claimedBy?: string | null;
    claimedBySource?: string | null;
    certaintyLanguage?: string | null;
  }): ClaimWithSource => ({
    id: claim.id,
    subject: claim.subject,
    claimValue: claim.claimValue,
    confidence: (claim.confidence || 'medium') as Confidence,
    claimedBy: claim.claimedBy || 'family',
    claimedBySource:
      (claim.claimedBySource as 'direct' | 'attributed' | 'hearsay') ||
      'direct',
    certaintyLanguage: claim.certaintyLanguage || undefined,
  });

  /**
   * Map a database event to TimelineEventInfo.
   */
  private mapEvent = (event: {
    id: string;
    title: string;
    eventType?: string | null;
    dateYear?: number | null;
    dateMonth?: number | null;
    dateApproximate?: string | null;
    place?: string | null;
    peopleInvolved?: string[] | null;
    confidence?: string | null;
  }): TimelineEventInfo => ({
    id: event.id,
    title: event.title,
    eventType: event.eventType || 'unknown',
    dateYear: event.dateYear || undefined,
    dateMonth: event.dateMonth || undefined,
    dateApproximate: event.dateApproximate || undefined,
    place: event.place || undefined,
    peopleInvolved: event.peopleInvolved || [],
    confidence: (event.confidence || 'medium') as Confidence,
  });

  /**
   * Map a database story to StorySummary.
   */
  private mapStory = (story: {
    id: string;
    title?: string | null;
    contentOriginal?: string | null;
    themes?: string[] | null;
    timeframe?: string | null;
    people?: string[] | null;
  }): StorySummary => ({
    id: story.id,
    title: story.title || 'Untitled Story',
    content: story.contentOriginal || '',
    themes: story.themes || [],
    timeframe: story.timeframe || undefined,
    peopleInvolved: story.people || [],
  });

  /**
   * Map a database image to ImageInfo.
   */
  private mapImage = (image: {
    id: string;
    analysis?: unknown;
    estimatedEra?: string | null;
    sharedBy?: string | null;
  }): ImageInfo => {
    const analysis = image.analysis as
      | { description?: string; peopleIdentified?: string[] }
      | undefined;
    return {
      id: image.id,
      description: analysis?.description,
      peopleIdentified: analysis?.peopleIdentified || [],
      estimatedEra: image.estimatedEra || undefined,
      sharedBy: image.sharedBy || undefined,
    };
  };
}
